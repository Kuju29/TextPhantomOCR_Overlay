"""The translation pipeline — turns a request payload into a render result.

This is the orchestration layer.  It does not contain any low-level logic
itself; it wires together the lens / ai / render modules:

    payload -> image bytes -> Lens OCR -> decode trees
            -> (optional) AI translate -> patch into Ai tree
            -> font fitting -> HTML overlays -> erase original text
            -> result dict

Two modes:
- ``lens_images`` — just return the (decoded) image, no OCR work.
- ``lens_text``   — full OCR + original/translated/AI render trees + HTML.
"""

from __future__ import annotations

import concurrent.futures
import contextlib
import copy
import io
import os
import tempfile
import threading
import time
from typing import Any

import numpy as np
from PIL import Image

from backend.ai import markers
from backend.ai.translate import AiConfig, translate as ai_translate
from backend.config import settings
from backend.jobs import cache as cache_mod
from backend.jobs.fonts import resolve_font_pair
from backend.lens import client as lens_client
from backend.lens import document as lens_document
from backend.lens.languages import normalize as normalize_lang
from backend.ai.providers import is_local_provider
from backend.lens.tree import (
    decode_tree,
    flatten_spans,
    iter_paragraphs,
    paragraph_texts,
    spans_for_paragraphs,
    tree_stats,
)
from backend.log import dbg, event
from backend.render.bubble import attach_bubble_bounds, detect_bubble_bounds_combined
from backend.render.colors import region_is_dark
from backend.render.textblocks_pass import detect_blocks_with_second_look
from backend.render.textblocks import (
    annotate_paragraph_blocks,
    attach_block_bounds_to_groups,
    available as textblocks_available,
    detect_text_blocks_in_rois,
)
from backend.render.erase import erase_text_with_boxes, restore_token_regions
from backend.render import erase_boxes as erase_boxes_mod
from backend.render.groups import (
    group_paragraphs_into_bubbles,
    merge_groups_sharing_canvas,
)
from backend.render.build_ai_tree import build_ai_tree
from backend.render.relayout import (
    build_vertical_rois,
    normalize_group_rotation_signs,
    rebuild_tree_for_target,
    relayout_decision,
    scan_tree_orientation,
    target_orientation_for_lang,
)
from backend.render.rotation_signs import presentation_rotation_copy
from backend.render.patch import patch as patch_ai_tree
from backend.render.tp_html import (
    fit_tree_font_sizes,
    overlay_css,
    render_tree_overlay,
)
from backend.utils.images import (
    bytes_to_data_uri,
    data_uri_to_bytes,
    download,
    sha256_hex,
)

SUPPORTED_MODES = {"lens_images", "lens_text"}


def _image_to_rgb(src: Image.Image) -> Image.Image:
    """Return opaque RGB, preserving palette transparency over white.

    Pillow warns when a palette image carries a per-entry alpha table and is
    converted straight to RGB.  More importantly, that direct conversion has
    no defined page background for transparent pixels. Manga pages are white,
    so promote to RGBA first and composite explicitly.
    """
    has_alpha = "A" in src.getbands() or "transparency" in src.info
    if not has_alpha:
        return src.convert("RGB")
    rgba = src.convert("RGBA")
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    return Image.alpha_composite(white, rgba).convert("RGB")

# --- Background-image encoding ----------------------------------------------
# The erased background does not need to be lossless. Scanned/JPEG-sourced
# pages carry sensor+compression noise that PNG must encode exactly (multi-MB
# payloads); WebP discards it and is typically several times smaller. Clean
# digital pages with large flat areas go the other way: PNG is both smaller
# AND faster on line art.
#
# This used to encode BOTH formats and return the smaller blob. That is the
# right answer for BYTES and the wrong one for CPU — it paid for two full
# encodes of every page on a 2-vCPU container where encoding is already the
# hottest stage of the direct lane. It now encodes ONCE, choosing the format
# from a sampled flatness measurement taken on a small native-resolution crop
# (tens of microseconds, versus ~0.3-1.5 s for the encode it replaces).
#
# TP_LENS_DIRECT_IMG_FORMAT:
#   auto (default) — sample the image, run exactly one encode
#   webp / png     — force one format, skip the sampling
#   compare        — the old behaviour: encode both, return the smaller.
#                    Roughly 2x the encode CPU; kept for A/B measurement.
_BG_FORMAT = (os.environ.get("TP_LENS_DIRECT_IMG_FORMAT", "auto") or "auto").strip().lower()
_WEBP_QUALITY = max(1, min(100, int(os.environ.get("TP_LENS_DIRECT_WEBP_QUALITY", "80"))))
# Pillow's WebP effort knob (0 fastest .. 6 smallest). 2 keeps most of the size
# win at a fraction of the default (4) cost.
_WEBP_METHOD = max(0, min(6, int(os.environ.get("TP_LENS_DIRECT_WEBP_METHOD", "2"))))
# --- "auto" format heuristic ---
# PNG only beats WebP on QUANTIZED art: screentone/halftone, line art, flat
# webtoon colour. On a measured 1400x2000 halftone page PNG is 54 KB and WebP
# q80 is 872 KB — 16x larger and 4x slower — so getting this class wrong is
# far more expensive than the sampling. On anything scanned or JPEG-sourced
# the ordering reverses hard (2374 KB PNG vs 125 KB WebP).
#
# Neither signal is sufficient alone:
#   • colour count alone misfires on flat-toned grey scans, which have few
#     distinct values but compress terribly as PNG because of pixel noise;
#   • flatness alone misfires on halftone, whose 2-3 px dither pattern puts
#     adjacency near 0.67 — well inside the range real scans occupy.
# Requiring BOTH is what separates them: quantized art has few colours AND
# long identical runs, scan noise has neither.
#
# Accepted trade: pure line art and flat webtoon colour would still be a few
# tens of KB smaller as WebP, and they are routed to PNG here. Those pages are
# 40-100 KB either way, so the loss is bounded and absolute; the cases this
# protects (halftone at 16x, scans at 19x) are measured in megabytes.
_MAX_PALETTE_COLORS = max(2, int(os.environ.get("TP_LENS_DIRECT_COLOR_LIMIT", "256")))
# Stride for the colour sample. NEAREST keeps exact pixel values, so counting
# distinct colours on the subsample stays meaningful (unlike the noise
# measurement below, which must be taken at native resolution).
_COLOR_SAMPLE_STEP = max(1, int(os.environ.get("TP_LENS_DIRECT_COLOR_STEP", "3")))
# Side of the native-resolution centre crop used to measure flatness.
_FLAT_SAMPLE_PX = max(32, int(os.environ.get("TP_LENS_DIRECT_SAMPLE_PX", "256")))
# Fraction of horizontally-adjacent identical pixels. Scans sit at 0.04-0.13,
# halftone at ~0.67, line art and flat colour above 0.98.
_FLAT_THRESHOLD = min(1.0, max(0.0, float(os.environ.get("TP_LENS_DIRECT_FLAT_THRESHOLD", "0.45"))))

# WebP support is a property of the Pillow BUILD, not of any single image, so
# it is resolved once here. Doing it per-call inside a bare `except` hid a
# permanently-degraded deployment behind a silent PNG fallback.
try:
    from PIL import features as _pil_features

    _WEBP_AVAILABLE = bool(_pil_features.check("webp"))
except Exception:  # noqa: BLE001 - very old Pillow without PIL.features
    _WEBP_AVAILABLE = False
if not _WEBP_AVAILABLE and _BG_FORMAT in ("auto", "webp"):
    event(
        "encode.webp_unavailable",
        {
            "requested_format": _BG_FORMAT,
            "detail": "Pillow was built without WebP; every background will be "
            "encoded as PNG (much larger payloads). Install a Pillow wheel "
            "with WebP support or set TP_LENS_DIRECT_IMG_FORMAT=png to make "
            "this explicit.",
        },
        ok=False,
    )


def _encode_png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def _encode_webp(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=_WEBP_QUALITY, method=_WEBP_METHOD)
    return buf.getvalue()


def _flatness(img: Image.Image) -> float:
    """Fraction of horizontally-adjacent identical pixels in a centre crop.

    Sampled at NATIVE resolution — downscaling first would smear exactly the
    per-pixel noise the measurement is looking for. The crop is capped at
    ``_FLAT_SAMPLE_PX`` per side, so this reads at most ~65k pixels regardless
    of page size.
    """
    w, h = img.size
    side = min(_FLAT_SAMPLE_PX, w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    crop = img.crop((left, top, left + side, top + side)).convert("L")
    arr = np.asarray(crop, dtype=np.uint8)
    if arr.ndim != 2 or arr.shape[1] < 2:
        raise ValueError(f"flatness sample has unusable shape {arr.shape}")
    return float(np.mean(arr[:, 1:] == arr[:, :-1]))


def _is_quantized_art(img: Image.Image) -> bool:
    """True for screentone / line art / flat colour — the pages PNG wins on."""
    w, h = img.size
    step = _COLOR_SAMPLE_STEP
    small = img.resize((max(1, w // step), max(1, h // step)), Image.NEAREST)
    # getcolors returns None past maxcolors, so this early-exits on real scans.
    if small.getcolors(maxcolors=_MAX_PALETTE_COLORS) is None:
        return False
    return _flatness(img) >= _FLAT_THRESHOLD


def _encode_bg_data_uri(img: Image.Image) -> str:
    """Encode the (erased) background image as a compact data URI.

    Runs exactly one encode unless ``TP_LENS_DIRECT_IMG_FORMAT=compare``.
    """
    if _BG_FORMAT == "png" or not _WEBP_AVAILABLE:
        return bytes_to_data_uri(_encode_png(img), "image/png")
    if _BG_FORMAT == "webp":
        return bytes_to_data_uri(_encode_webp(img), "image/webp")
    if _BG_FORMAT == "compare":
        png_bytes = _encode_png(img)
        webp_bytes = _encode_webp(img)
        if len(webp_bytes) < len(png_bytes):
            return bytes_to_data_uri(webp_bytes, "image/webp")
        return bytes_to_data_uri(png_bytes, "image/png")

    # "auto": sample (<1 ms), then run exactly one encode.
    if _is_quantized_art(img):
        return bytes_to_data_uri(_encode_png(img), "image/png")
    return bytes_to_data_uri(_encode_webp(img), "image/webp")


# CPU gate: workers may all wait on the Lens network call in parallel (cheap),
# but only this many jobs may run the CPU-heavy stages (erase / bubble detect /
# render / PNG) at once. Without the gate, a 14-image burst inflated those
# stage times 3-10x from GIL contention; with too few workers, the Lens waits
# serialized instead. I/O parallel + CPU gated gets both right.
_CPU_GATE = threading.Semaphore(max(1, settings.cpu_concurrency))

# Warn LOUDLY (once per process) when the text-block model could not be used:
# vertical grouping then runs on the geometric fallback, and anyone debugging
# a grouping issue must know which decision path produced the result.
_tb_fallback_warned = False


def _warn_textblocks_fallback() -> None:
    global _tb_fallback_warned
    if not _tb_fallback_warned:
        _tb_fallback_warned = True
        event(
            "textblocks.unavailable",
            {
                "hint": "vertical grouping is on the GEOMETRIC FALLBACK — "
                "check onnxruntime install / model download (TP_TEXTBLOCK_MODEL)",
            },
            ok=False,
        )


# --- Template-tree selection ----------------------------------------------

def _tree_score(tree: Any) -> int:
    """Score a tree by how much geometry it carries (more items => better).

    Used to pick which tree (original vs translated) makes the best template
    for the AI layout — the AI text is poured into the template's boxes.
    """
    if not isinstance(tree, dict):
        return -1
    paragraphs = tree.get("paragraphs") or []
    if not isinstance(paragraphs, list) or not paragraphs:
        return -1
    item_count = span_count = 0
    for p in paragraphs:
        if not isinstance(p, dict):
            continue
        items = p.get("items") or []
        item_count += len(items)
        for it in items:
            if isinstance(it, dict):
                span_count += len(it.get("spans") or [])
    return item_count * 10000 + len(paragraphs) * 100 + span_count


def _pick_template_tree(original_tree: dict | None, translated_tree: dict | None) -> dict:
    """Choose the AI layout template.

    The **Translated** tree is strongly preferred: it is Lens's own
    target-language layout, so its line counts, free-angle baselines and
    curve polylines already suit the speech bubbles for the target language.
    The Original tree is only used when Translated is empty/degenerate
    (its line breaks follow source-language word boundaries, which distribute
    badly for languages like Thai).
    """
    tr_score = _tree_score(translated_tree)
    og_score = _tree_score(original_tree)
    if tr_score > 0:
        return translated_tree or {}
    if og_score > 0:
        return original_tree or {}
    return translated_tree or original_tree or {}


def _should_use_onnx_for_ai(
    original_tree: dict | None,
    translated_tree: dict | None,  # noqa: ARG001 - reserved for future geometry quality checks
    target_lang: str,
) -> tuple[bool, dict[str, Any]]:
    """Decide whether ``lens_text.ai`` really needs the ONNX self-block path.

    The AI layer has no user switch: it always builds its own geometry from the
    target language, because there is no sensible "leave it rotated" answer for
    a layer that exists to produce readable translated text. Policy:

      * ``TP_AI_LAYOUT_MODE=fast``    -> never run ONNX; patch AI into Lens geometry.
      * ``TP_AI_LAYOUT_MODE=quality`` -> always run ONNX.
      * ``auto`` (default)            -> run ONNX only when source and target
        reading orientations differ, e.g. vertical Japanese -> horizontal Thai
        or horizontal English -> vertical Japanese.

    Horizontal -> horizontal AI stays on the fast Lens-template path.
    """
    mode = (getattr(settings, "ai_layout_mode", "auto") or "auto").strip().lower()
    source_orientation, scan = scan_tree_orientation(original_tree)
    target_orientation = target_orientation_for_lang(target_lang)
    # Keep the historical ``source_*`` key names so existing log queries and
    # dashboards built on translate.perf keep working.
    meta: dict[str, Any] = {
        "source_orientation": source_orientation,
        "source_axis_items": scan["axis_items"],
        "source_vertical_items": scan["vertical_items"],
        "source_horizontal_items": scan["horizontal_items"],
        "source_items": scan["items"],
        "rotation_samples": scan["rotation_samples"],
        "target_orientation": target_orientation,
        "ai_layout_mode": mode,
    }
    if mode in ("fast", "lens", "lens_template", "direct", "0", "off", "false", "no"):
        meta["onnx_reason"] = "forced_fast"
        return False, meta
    if mode in ("quality", "onnx", "self", "self_blocks", "1", "true", "yes"):
        meta["onnx_reason"] = "forced_quality"
        return True, meta
    if source_orientation != target_orientation:
        meta["onnx_reason"] = "direction_change"
        return True, meta
    meta["onnx_reason"] = "same_orientation_fast"
    return False, meta


# --- Per-request layout options --------------------------------------------

def _layout_options(payload: dict | None) -> dict[str, bool]:
    """Resolve the ``layout`` switches for one request.

    The extension sends ``{"layout": {"relayout_translated": bool}}``.  A
    missing key falls back to the server default in :mod:`backend.config` —
    that fallback is for clients that predate the switch, so it must stay
    explicit rather than being silently coerced to ``False`` by a truthiness
    test on an absent field.
    """
    raw = payload.get("layout") if isinstance(payload, dict) else None
    raw = raw if isinstance(raw, dict) else {}

    def _flag(key: str, default: bool) -> bool:
        if key not in raw or raw[key] is None:
            return default
        value = raw[key]
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)

    render = payload.get("render") if isinstance(payload, dict) else None
    render = render if isinstance(render, dict) else {}

    return {
        "relayout_translated": _flag(
            "relayout_translated", bool(getattr(settings, "relayout_translated", True))
        ),
        # Emit the canonical tp.lens-document/1 alongside the rendered overlay.
        # It changes the response, so it belongs in the cache key.
        "lens_document": bool(render.get("lensDocument")),
        # Who paints the text-erased background. These produce different
        # responses from the same image, so this belongs in the cache key
        # alongside the relayout switches — see build_cache_key.
        "client_background": _background_is_client(payload),
    }


# --- Background ownership ---------------------------------------------------

_BACKGROUND_MODES = ("image", "boxes")


def _background_is_client(payload: dict | None) -> bool:
    """Whether the CLIENT will paint the background for this request.

    ``{"render": {"background": "boxes"}}`` means the extension erases the
    text itself on a canvas, so the server skips the inpaint/re-encode and
    returns the boxes instead. ``"image"`` (the default, and what every older
    build sends by not sending anything) keeps the server-rendered background.

    An unrecognised value raises rather than falling back to the default: a
    client that asked for something specific and silently got the opposite
    would look like a client-side bug for as long as anyone cared to look.
    """
    raw = payload.get("render") if isinstance(payload, dict) else None
    raw = raw if isinstance(raw, dict) else {}
    value = raw.get("background")
    if value is None or value == "":
        return False
    mode = str(value).strip().lower()
    if mode not in _BACKGROUND_MODES:
        raise ValueError(
            f"render.background must be one of {_BACKGROUND_MODES}, got {value!r}"
        )
    return mode == "boxes"


# --- Text-colour annotation -------------------------------------------------

def _para_rect_px(para: dict) -> tuple[int, int, int, int] | None:
    """Paragraph rect in pixels — ``bounds_px`` or the union of item bounds."""
    bp = para.get("bounds_px")
    if isinstance(bp, (list, tuple)) and len(bp) == 4:
        x1, y1, x2, y2 = (int(round(float(v))) for v in bp)
        return x1, y1, x2, y2
    xs1: list[float] = []
    ys1: list[float] = []
    xs2: list[float] = []
    ys2: list[float] = []
    for it in para.get("items") or []:
        ib = it.get("bounds_px")
        if isinstance(ib, (list, tuple)) and len(ib) == 4:
            xs1.append(float(ib[0]))
            ys1.append(float(ib[1]))
            xs2.append(float(ib[2]))
            ys2.append(float(ib[3]))
    if not xs1:
        return None
    return int(min(xs1)), int(min(ys1)), int(max(xs2)), int(max(ys2))


def _annotate_text_light(tree: dict | None, base_img: Image.Image | None) -> None:
    """Flag paragraphs sitting on a DARK background with ``text_light``.

    The renderer turns the flag into the ``tp-on-dark`` wrapper (white text +
    dark halo) so overlays stay readable on black/dark panels.  Sampling uses
    the erased image, where the original glyphs are already gone.
    """
    if not isinstance(tree, dict) or base_img is None:
        return
    for para in tree.get("paragraphs") or []:
        if not isinstance(para, dict):
            continue
        rect = _para_rect_px(para)
        if rect is None:
            continue
        try:
            para["text_light"] = region_is_dark(base_img, rect)
        except Exception:
            para["text_light"] = False


# --- AI layer --------------------------------------------------------------

_VISION_MAX_SIDE = 1024
_VISION_JPEG_QUALITY = 72


def _encode_vision_image(img: Image.Image) -> tuple[str, str]:
    """Downscale + JPEG-encode the page for the vision prompt.

    Returns ``(base64_data, mime)``.  Kept small (max side 1024, q72) so the
    extra input tokens stay reasonable while faces / who-talks-to-whom remain
    perfectly readable for the model.
    """
    import base64
    import io

    w, h = img.size
    scale = _VISION_MAX_SIDE / float(max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    if img.mode != "RGB":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=_VISION_JPEG_QUALITY)
    return base64.b64encode(buf.getvalue()).decode("ascii"), "image/jpeg"


@contextlib.contextmanager
def _stage(stages: dict[str, Any], name: str):
    """Name the step being run, and stamp that name onto anything it raises.

    Without this a failure before the provider reaches the client as a bare
    ``RuntimeError`` and nobody can tell a download from a Lens upload from a
    decode. The marker is read by the route and written into the failure trace;
    guessing with a retry would only hide which step is broken.
    """
    stages["stage"] = name
    try:
        yield
    except BaseException as exc:
        stages["failed_stage"] = name
        if getattr(exc, "tp_stage", None) is None:
            try:
                exc.tp_stage = name  # type: ignore[attr-defined]
            except Exception:
                pass
        raise


def _restore_unanswered_paragraphs(
    out: dict[str, Any],
    original_tree: dict | None,
    source_img: "Image.Image | None",
    base_img: "Image.Image | None",
    *,
    client_background: bool,
    stages: dict[str, Any],
) -> int:
    """Undo the erase for paragraphs the model did not answer.

    The page is erased before the AI replies, so a partial answer leaves the
    unanswered bubbles blank — the reader loses text that was there before the
    translation ran. The extension already refuses to erase what it cannot
    replace; this is the same rule on the server. Returns how many paragraphs
    were restored.
    """
    meta = ((out.get("Ai") or {}).get("meta") or {})
    indices = meta.get("missing_paragraph_indices") or []
    if not indices:
        return 0
    tokens = spans_for_paragraphs(original_tree, indices)
    if not tokens:
        return 0

    if client_background:
        # The client paints the boxes: simply do not send the ones whose text
        # is staying on screen.
        keep = spans_for_paragraphs(
            original_tree,
            [i for i, _ in iter_paragraphs(original_tree) if i not in set(indices)],
        )
        out["eraseBoxes"] = erase_boxes_mod.build(keep)
    elif base_img is not None and source_img is not None:
        _t = time.perf_counter()
        restore_token_regions(base_img, source_img, tokens)
        if settings.lens_direct_png:
            out["imageDataUri"] = _encode_bg_data_uri(base_img)
        stages["ai_partial_restore_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    else:
        return 0

    stages["ai_partial_restored_paragraphs"] = len(indices)
    dbg("ai.partial.restored", {"paragraphs": indices})
    return len(indices)


def _run_ai_layer(
    out: dict[str, Any],
    original_tree: dict | None,
    translated_tree: dict | None,
    ai_cfg: AiConfig,
    target_lang: str,
    W: int,
    H: int,
    thai_font: str,
    latin_font: str,
    *,
    base_img: Image.Image | None = None,
    vision_img: Image.Image | None = None,
    capture_request: bool = False,
    use_lens_template: bool = False,
    layout_meta: dict[str, Any] | None = None,
) -> dict | None:
    """Translate with AI, patch into a tree, and write the ``Ai`` result.

    Returns the AI tree (or ``None`` when there is nothing to translate).
    Mutates ``out`` (sets ``AiTextFull`` / ``Ai``) and the passed-in trees
    (font sizes are shared across all three layers).
    """
    src_paras_raw = paragraph_texts(original_tree or {})

    # Build one translation unit per bubble group so short fragments (e.g. "そ"
    # at the top of a vertical bubble) are translated in context together with
    # their neighbours ("そんなことないよ!") rather than in isolation.
    # bubble_groups["text"] already holds the correctly joined source text with
    # the right separator (no space for CJK/Thai, space for Latin) thanks to
    # groups.py.
    bubble_groups_og = (original_tree or {}).get("bubble_groups") or []
    group_para_indices: list[list[int]] = []
    merged_src_paras: list[str] = []
    grouping_degraded = False

    if bubble_groups_og and src_paras_raw:
        in_group: set[int] = set()
        for bg in bubble_groups_og:
            idxs = sorted(int(i) for i in (bg.get("para_indices") or []))
            combined = str(bg.get("text") or "").strip()
            if combined:
                group_para_indices.append(idxs)
                merged_src_paras.append(combined)
                in_group.update(idxs)
        # Include any paragraphs not covered by a bubble_group.
        for i, t in enumerate(src_paras_raw):
            if i not in in_group and (t or "").strip():
                group_para_indices.append([i])
                merged_src_paras.append(t)
    else:
        # Fallback: one unit per paragraph (original behaviour).
        #
        # This is a QUALITY DEGRADATION, not a neutral default: without bubble
        # groups a vertical page arrives as one unit per column, so a single
        # sentence Lens split across three columns is translated three times in
        # isolation. The extension refuses this case outright; the server takes
        # it, and the only thing that makes the two comparable is saying so.
        for i, t in enumerate(src_paras_raw):
            group_para_indices.append([i])
            merged_src_paras.append(t)
        grouping_degraded = bool(src_paras_raw)

    # Units Lens read as digits, punctuation or symbols only are never sent: they
    # cost tokens, come back unchanged, and their source text is the right answer.
    # Same rule as `hasTranslatableText` in src/shared/lens-document.js.
    passthrough_units: dict[int, str] = {}
    kept_indices: list[list[int]] = []
    kept_paras: list[str] = []
    for idxs, text in zip(group_para_indices, merged_src_paras):
        if markers.has_translatable_text(text):
            kept_indices.append(idxs)
            kept_paras.append(text)
        else:
            passthrough_units[len(kept_indices) + len(passthrough_units)] = text
    if not kept_paras:
        out["AiTextFull"] = ""
        out["Ai"] = {"meta": {"skipped": True, "skipped_reason": "no_translatable_text"}}
        return None
    untranslatable = len(group_para_indices) - len(kept_paras)
    if untranslatable:
        # The boxes still need their text, so the source is written back verbatim.
        group_para_indices = kept_indices + [
            idxs for idxs, text in zip(group_para_indices, merged_src_paras)
            if not markers.has_translatable_text(text)
        ]
        passthrough_texts = [
            text for text in merged_src_paras if not markers.has_translatable_text(text)
        ]
        merged_src_paras = kept_paras
    else:
        passthrough_texts = []
        group_para_indices = kept_indices
        merged_src_paras = kept_paras

    # Clamp runaway character runs in the SOURCE from the very first attempt
    # (SFX like ヒヤァァァ… are the usual trigger that sends the model into a
    # repetition loop). Previously this only happened on the retry pass.
    merged_src_paras = [markers.clamp_runaway_repeats(p) for p in merged_src_paras]
    src_text = markers.apply(merged_src_paras)
    n_src = len(merged_src_paras)

    if not markers.has_meaningful_text(src_text):
        out["AiTextFull"] = ""
        out["Ai"] = {"meta": {"skipped": True, "skipped_reason": "no_text"}}
        return None

    # The model now sees only the source — no Lens MT reference block.
    # This halves the prompt input and lets it translate freely, which
    # produced noticeably more natural Thai/JP/ZH/KO dialogue than the
    # previous "improve on the Lens MT" approach.

    # Vision (opt-in): attach a downscaled page image so the model can SEE
    # speaker gender / expressions / who talks to whom.  ``base_img`` may have
    # its text erased for rendering, so prefer the untouched ``vision_img``.
    #
    # Modes: True/"always" = every page.  "auto" = only pages that look like
    # real dialogue (enough OCR text units) while the character sheet is still
    # thin — covers, title and credits pages have few text blocks and teach
    # the model nothing, so they stay cheap text-only.
    _send = getattr(ai_cfg, "send_image", False)
    _send_mode = str(_send).strip().lower() if _send else ""
    want_image = _send is True or _send_mode in ("always", "true", "1")
    if _send_mode == "auto":
        known_chars = len(getattr(ai_cfg, "characters", None) or [])
        want_image = n_src >= 5 and known_chars < 4
    if want_image and not getattr(ai_cfg, "image_b64", ""):
        vimg = vision_img if vision_img is not None else base_img
        if vimg is not None:
            try:
                ai_cfg.image_b64, ai_cfg.image_mime = _encode_vision_image(vimg)
            except Exception as exc:  # noqa: BLE001
                # Was a bare `pass`. A page that silently translated text-only
                # while the user believed the model could see it is a setting
                # that "does nothing" for no visible reason.
                event(
                    "ai.vision.skipped",
                    {"reason": str(exc)[:200], "size": list(vimg.size)},
                    ok=False,
                )

    # Measured on a real page (api/logs, 2026-08-06): text-only ~2s, the same
    # page with the image attached and thinking left on took 85s. That is a
    # 40x cost from two switches that look independent in the UI and are not.
    #
    # Not changed automatically — silently overriding a setting is how the last
    # three regressions happened. Stated, so the cost is attributable.
    if want_image and str(getattr(ai_cfg, "thinking", "default")).lower() != "off":
        event(
            "ai.vision.expensive",
            {
                "note": "page image + thinking is the slow combination; "
                "setting AI thinking to 'off' is the single biggest saving",
                "model": getattr(ai_cfg, "model", ""),
            },
        )

    # Chapter-brief speaker map: the brief numbers speakers by RAW OCR
    # paragraph index (blank-line split of originalTextFull), but the markers
    # sent to the model are BUBBLE-GROUP units (several raw paragraphs can
    # merge into one marker). Remap raw -> group here so the SPEAKER MAP's
    # <<TP_Pn>> labels line up with what the model actually receives.
    _raw_speakers = getattr(ai_cfg, "speakers", None) or {}
    if _raw_speakers:
        _remapped: dict[str, str] = {}
        for _gi, _idxs in enumerate(group_para_indices):
            for _ri in _idxs:
                _name = str(_raw_speakers.get(str(_ri)) or "").strip()
                if _name:
                    _remapped[str(_gi)] = _name
                    break
        ai_cfg.speakers = _remapped

    # Exactly one AI generation for this image. Provider-native JSON Schema
    # constrains P0..Pn where available; universal JSON prompting covers every
    # other model. Incomplete output is terminal inside ai_translate — never
    # repaired from Lens and never offered to the model a second time.
    result = ai_translate(
        src_text, target_lang, ai_cfg,
        capture_request=capture_request,
    )

    # OUTPUT clamp — deterministic, always on. A repetition runaway in the
    # model's answer (thousands of repeated chars/clusters) can strike at any
    # time; collapsing it here guarantees it never reaches parsing/rendering.
    ai_text_full = markers.clamp_output_repeats(str(result.get("aiTextFull") or ""))
    meta = dict(result.get("meta") or {})
    if isinstance(layout_meta, dict):
        meta.update({f"layout_{k}": v for k, v in layout_meta.items() if k != "rotation_samples"})
        if "rotation_samples" in layout_meta:
            meta["layout_rotation_samples"] = layout_meta.get("rotation_samples")
    meta["layout_path"] = "lens_template_fast" if use_lens_template else "self_blocks_onnx"

    # The marker sequence must be structurally complete: the decoder fills an
    # omitted id with an empty body rather than dropping it, so a gap here means
    # the protocol itself broke, not that the model skipped one bubble.
    if merged_src_paras and not markers.has_complete_sequence(ai_text_full, n_src):
        raise RuntimeError(f"AI returned incomplete text units (expected {n_src})")

    dbg("ai.groups", {"n_groups": n_src, "n_paras": len(src_paras_raw)})

    # Extract per-group translated texts.
    extracted = markers.extract_paragraphs(ai_text_full, n_src)
    if extracted is None:
        raise RuntimeError("AI returned no attributable text units")
    ai_group_texts, ai_text_full_clean = extracted

    # A unit the model returned empty stays empty and is named. Same rule as the
    # extension path: draw what came back, report the rest, never invent filler.
    missing_units = [i for i, t in enumerate(ai_group_texts) if not str(t or "").strip()]
    if missing_units and len(missing_units) >= n_src:
        raise RuntimeError("AI returned no usable text for any unit")
    if passthrough_texts:
        ai_group_texts = list(ai_group_texts) + list(passthrough_texts)
    meta["missing_units"] = missing_units
    meta["passthrough_units"] = len(passthrough_texts)
    meta["units"] = n_src
    # Named so a log can tell "the server grouped the page" from "the server
    # gave up on grouping and translated the fragments anyway".
    meta["grouping"] = "per_paragraph_fallback" if grouping_degraded else "bubble_groups"
    if grouping_degraded:
        dbg("ai.grouping.degraded", {"units": n_src})
        event(
            "ai.grouping.degraded",
            {"units": n_src,
             "note": "no bubble groups: each Lens paragraph was translated on its own, "
                     "so one sentence split across columns was translated in fragments"},
            ok=False,
        )
    # Which SOURCE paragraphs those units came from. The erase already ran, so
    # the caller needs this to put the original pixels back before the reply is
    # encoded — an unanswered bubble must show its own text, never a blank.
    missing_paras: set[int] = set()
    for unit in missing_units:
        if 0 <= unit < len(group_para_indices):
            missing_paras.update(int(i) for i in group_para_indices[unit])
    meta["missing_paragraph_indices"] = sorted(missing_paras)
    if missing_units:
        dbg("ai.partial", {"expected": n_src, "missing": len(missing_units),
                           "missing_units": missing_units,
                           "missing_paragraph_indices": sorted(missing_paras)})

    if use_lens_template:
        # Fast same-orientation AI path: pour the AI wording into Lens's own
        # geometry instead of constructing new blocks with ONNX/bubble detect.
        # This is the right path for horizontal->horizontal and vertical->vertical
        # text because Lens already returned suitable paragraph/item boxes.
        template_tree = _pick_template_tree(original_tree, translated_tree)
        # If group_para_indices is just a one-to-one paragraph map, patching
        # without a group_map is cheaper and preserves Lens paragraphs exactly.
        one_to_one = (
            len(group_para_indices) == len((template_tree or {}).get("paragraphs") or [])
            and all(len(xs) == 1 and xs[0] == i for i, xs in enumerate(group_para_indices))
        )
        patched = patch_ai_tree(
            ai_text_full_clean,
            template_tree,
            W, H,
            thai_font, latin_font,
            target_lang,
            group_map=None if one_to_one else group_para_indices,
        )
        ai_tree = patched.get("aiTree") or {}
        ai_text_full_clean = str(patched.get("aiTextFull") or ai_text_full_clean)
    else:
        # Quality / direction-change AI path: build a fresh AI tree from bubble
        # geometry + target language direction.  This is intentionally reserved
        # for cases like vertical Japanese -> horizontal Thai where Lens boxes
        # are too narrow for the new reading direction.
        ai_tree = build_ai_tree(
            bubble_groups_og,
            ai_group_texts,
            original_tree or {},
            target_lang,
            W, H,
        )

        # After building the AI tree, compute bubble_groups so the renderer can
        # use the combined group text directly.
        from backend.render.groups import group_paragraphs_into_bubbles as _grp
        _grp(ai_tree, W, H)

    out["AiTextFull"] = ai_text_full_clean
    out["Ai"] = {"aiTextFull": ai_text_full_clean, "aiTree": ai_tree, "meta": meta}

    # Glossary pairs (source -> translated) for this image, so the client can
    # accumulate a translation memory across a multi-image batch and feed it
    # back via ``ai.glossary`` on later requests (terminology consistency).
    # Pairs short, term-like units only (<= 24 source chars) — full sentences
    # are too specific to reuse and would bloat the next prompt.
    glossary_pairs: list[dict] = []
    for idxs, src in zip(group_para_indices, merged_src_paras):
        gi2 = group_para_indices.index(idxs)
        tgt = ai_group_texts[gi2] if gi2 < len(ai_group_texts) else ""
        src_s = (src or "").strip()
        tgt_s = (tgt or "").strip()
        if src_s and tgt_s and len(src_s) <= 24:
            glossary_pairs.append({"src": src_s, "tgt": tgt_s})
    out["Ai"]["glossary"] = glossary_pairs

    # Character-sheet notes the model emitted for this page (<<TP_MEMO>>).
    # The client merges these by name across pages and sends them back via
    # ``ai.characters`` so gender / pronouns / register stay right series-wide.
    chars = meta.get("characters")
    out["Ai"]["characters"] = chars if isinstance(chars, list) else []

    # Flag dark-background paragraphs BEFORE rendering so the overlay flips
    # to white text + dark halo where the panel behind the bubble is dark.
    _annotate_text_light(ai_tree, base_img)

    # AI HTML overlay — ``target_lang`` drives the deterministic reading
    # direction (see backend.render.region.resolve_text_direction).
    out["Ai"]["aihtml"] = render_tree_overlay(ai_tree, W, H, target_lang=target_lang)
    out["Ai"]["aihtmlMeta"] = {"baseW": int(W), "baseH": int(H), "format": "tp"}

    dbg("ai.built", {"stats_ai": tree_stats(ai_tree), "lang": target_lang})
    return ai_tree


# --- Core processing -------------------------------------------------------

def process_image(
    image_path: str,
    lang: str,
    mode: str,
    ai_cfg: AiConfig | None,
    *,
    source: str = "translated",
    lens_data: dict[str, Any] | None = None,
    capture_ai_request: bool = False,
    layout_opts: dict[str, bool] | None = None,
) -> dict[str, Any]:
    """Run the full pipeline on a local image file.

    ``lens_data`` may be passed in to skip the Google Lens fetch — useful for
    the local CLI (``backend.cli``), which can save and replay a Lens response
    so the Lens round-trip isn't repeated on every run.

    ``layout_opts`` carries the per-request relayout switch
    (``relayout_translated``); see :func:`_layout_options`.
    """
    mode_id = mode if mode in SUPPORTED_MODES else "lens_images"
    source_id = str(source or "translated").strip().lower() or "translated"
    target_lang = normalize_lang(lang)
    layout = layout_opts if isinstance(layout_opts, dict) else _layout_options(None)

    # `lens_images` returns Lens's own translated PICTURE — there is no erased
    # background to hand over, so the boxes mode does not apply to it. The
    # answer is reported in the result (`backgroundMode`) rather than left for
    # the client to infer from a missing field.
    client_background = bool(layout.get("client_background")) and mode_id == "lens_text"
    want_lens_document = bool(layout.get("lens_document")) and mode_id == "lens_text"

    # IMPORTANT pipeline contract:
    #   * lens_images                 -> Lens-direct image result
    #   * lens_text.original          -> Lens-direct OCR/layout overlay
    #   * lens_text.translated        -> Lens-direct translated layout overlay,
    #                                    OR (switch on + axis change) the same
    #                                    Lens MT text re-laid out at the target
    #                                    orientation via the self-block path
    #   * lens_text.ai                -> AUTO:
    #       - same orientation        -> fast Lens-template AI, no ONNX
    #       - direction changed       -> self-built block path with ONNX
    wants_ai = (mode_id == "lens_text" and source_id == "ai" and ai_cfg is not None)
    needs_self_blocks = False
    ai_layout_meta: dict[str, Any] = {}
    # Set once the translated layer has been rebuilt at the target orientation.
    relayout_translated = False
    tr_layout_meta: dict[str, Any] = {}

    # Per-stage wall-clock timings (ms), surfaced via the translate.perf log
    # line so slow jobs can be diagnosed from the logs alone.
    stages: dict[str, Any] = {"pipeline_path": "lens_direct"}

    with _stage(stages, "image_decode"):
        with Image.open(image_path) as src_img:
            img = _image_to_rgb(src_img)
        W, H = img.size
    thai_font, latin_font = resolve_font_pair(target_lang)

    # =========================================================
    # Phase 1 — Lens fetch. ONNX does NOT run here.
    #
    # This block used to carry a `Lens || ONNX` thread pool and a comment
    # promising it saved ~1.3 s. It was guarded by `_need_onnx`, which was
    # assigned `False` on the line above it and nowhere else — so no request
    # ever entered it. Removed on 2026-08-07, with no behaviour change by
    # construction: a branch that cannot be reached cannot be doing anything.
    #
    # The serialisation is deliberate, not an oversight. Which detector run is
    # needed — full page, ROI crops, or none at all — is decided by
    # `_should_use_onnx_for_ai` from Lens's own geometry, so ONNX genuinely
    # cannot start until Lens has answered. Running it speculatively during the
    # Lens wait would produce full-page boxes that the ROI path then has to
    # discard, which is a different answer, not an earlier one.
    #
    # Measured 2026-08-07 on 2 vCPU (same as an HF free Space): one warm
    # inference is ~262 ms, not the 1.3 s the deleted comment claimed. The real
    # ONNX run happens below, after the decision, as `detect_text_blocks_in_rois`.
    # =========================================================
    _tb_timings: dict = {}
    text_blocks: list = []
    stages["blocks_ms"] = 0.0
    if isinstance(lens_data, dict):
        # Lens result pre-supplied (CLI replay): no HTTP call to time.
        data: dict = lens_data
        stages["lens_ms"] = 0.0
    else:
        _t_p1 = time.perf_counter()
        with _stage(stages, "lens_fetch"):
            _raw = lens_client.fetch_lens_data(image_path, target_lang, settings.firebase_url)
        stages["lens_ms"] = round((time.perf_counter() - _t_p1) * 1000, 1)
        data = _raw if isinstance(_raw, dict) else {}

    if not isinstance(data, dict):
        data = {}
    stages["blocks"] = len(text_blocks)
    # Split: in batches most of blocks_ms is WAITING for the shared model
    # lock (other jobs' inference), not this job's own inference.
    stages["blocks_lock_ms"] = float(_tb_timings.get("lock_ms", 0.0))
    stages["blocks_infer_ms"] = float(_tb_timings.get("infer_ms", 0.0))

    image_url = data.get("imageUrl")
    out: dict[str, Any] = {
        "mode": mode_id,
        "imageUrl": image_url,
        "imageDataUri": "",
        "originalContentLanguage": data.get("originalContentLanguage"),
        "originalTextFull": data.get("originalTextFull"),
        "translatedTextFull": data.get("translatedTextFull"),
        "AiTextFull": "",
        "originalParagraphs": data.get("originalParagraphs") or [],
        "translatedParagraphs": data.get("translatedParagraphs") or [],
        "original": {},
        "translated": {},
        "Ai": {},
        "perfStages": stages,
        "pipelinePath": "lens_direct",
        # Who painted the background, stated rather than implied. A client that
        # asked for "boxes" and got "image" (lens_images, or an older server)
        # can see that immediately instead of discovering it as a missing field.
        "backgroundMode": "boxes" if client_background else "image",
    }

    # --- lens_images: just hand back the image -----------------------------
    if mode_id == "lens_images":
        if image_url:
            decoded = lens_client.decode_image_url_to_data_uri(str(image_url))
            if decoded:
                out["imageDataUri"] = decoded
            elif isinstance(image_url, str) and image_url.startswith(("http://", "https://")):
                blob, mime = download(image_url)
                out["imageDataUri"] = bytes_to_data_uri(blob, mime or "image/jpeg")
        if not out["imageDataUri"]:
            with open(image_path, "rb") as f:
                out["imageDataUri"] = bytes_to_data_uri(f.read(), "image/jpeg")
        return out

    # --- lens_text: decode trees -------------------------------------------
    stages["stage"] = "tree_decode"
    original_tree = decode_tree(
        out["originalParagraphs"], out["originalTextFull"] or "", "original", W, H
    )
    # The Original server renderer needs the OCR language on its hidden
    # browser-translate targets. Reader pages often declare `lang=en` even
    # when the manga text is Japanese; without this override Chrome can treat
    # Japanese OCR as English and leave Japanese fragments after Translate.
    original_tree["source_lang"] = str(data.get("originalContentLanguage") or "").strip()
    translated_tree = decode_tree(
        out["translatedParagraphs"], out["translatedTextFull"] or "", "translated", W, H
    )
    # The tree that actually gets rendered as the translated overlay. It is
    # ``translated_tree`` unless the relayout below replaces it with a rebuilt
    # one; keeping them separate means the AI layer and the debug export still
    # see Lens's untouched structure.
    translated_render_tree = translated_tree
    out["original"] = {"originalTree": original_tree, "originalTextFull": out["originalTextFull"] or ""}
    out["translated"] = {
        "translatedTree": translated_tree,
        "translatedTextFull": out["translatedTextFull"] or "",
    }
    dbg("tree.original", tree_stats(original_tree))
    dbg("tree.translated", tree_stats(translated_tree))

    if wants_ai:
        needs_self_blocks, ai_layout_meta = _should_use_onnx_for_ai(
            original_tree, translated_tree, target_lang
        )
        stages.update(ai_layout_meta)

    # Translated relayout: decided from the TRANSLATED tree's own geometry,
    # because that is the tree whose text gets re-laid out.  Lens gives the MT
    # layer the source's boxes, so a vertical Japanese page yields vertical Thai
    # columns — this is the check that catches it.  Only ``lens_text`` jobs that
    # actually display the translated layer pay for it (the AI layer replaces
    # that overlay anyway, and the original layer must always keep Lens
    # geometry so it lines up with the untouched glyphs).
    if mode_id == "lens_text" and source_id == "translated":
        relayout_translated, tr_layout_meta = relayout_decision(
            translated_tree, target_lang, enabled=layout["relayout_translated"]
        )
        stages.update(
            {f"tr_{k}": v for k, v in tr_layout_meta.items() if k != "rotation_samples"}
        )
        stages["tr_relayout"] = relayout_translated

    # Vertical pages need the text-block model even when nothing is being
    # rotated.  Lens returns vertical Japanese as one paragraph PER COLUMN with
    # no set boundaries, so without grouping:
    #   * Original  — the browser-translate targets are per column, so Chrome
    #     translates fragments out of order instead of whole bubbles;
    #   * Translated — columns of one sentence render as separate boxes and can
    #     even face opposite ways (+/-90 decode noise).
    # Grouping is what fixes both, and only vertical pages pay for it.
    needs_groups = False
    if mode_id == "lens_text" and source_id in ("original", "translated") and not relayout_translated:
        _grp_tree = original_tree if source_id == "original" else translated_tree
        _grp_orient, _grp_scan = scan_tree_orientation(_grp_tree)
        needs_groups = _grp_orient == "v" and int(_grp_scan.get("axis_items") or 0) > 0
        stages["group_scan_orientation"] = _grp_orient
        stages["group_pass"] = needs_groups

    if wants_ai or relayout_translated or needs_groups:
        if wants_ai:
            stages["pipeline_path"] = "self_blocks_ai" if needs_self_blocks else "lens_ai_fast"
        else:
            stages["pipeline_path"] = "self_blocks_translated"
        out["pipelinePath"] = stages["pipeline_path"]

    # The self-block path is shared: both the AI relayout and the translated
    # relayout need real bubble geometry (detected text blocks + bubble
    # outlines), so either one turns it on.
    if needs_self_blocks or relayout_translated or needs_groups:
        needs_self_blocks = True
        # Crop to the vertical regions Lens found, so the detector sees those
        # columns at full resolution instead of shrunk inside the whole page.
        # The ROI tree is whichever layer drove the decision: the AI layer works
        # from the ORIGINAL geometry, the translated layers from their own.
        _roi_tree = (
            translated_tree
            if (not wants_ai and source_id == "translated")
            else original_tree
        )
        _t_roi = time.perf_counter()
        _rois = build_vertical_rois(
            _roi_tree, W, H, margin_ratio=settings.vertical_roi_margin_ratio
        )
        stages["roi_build_ms"] = round((time.perf_counter() - _t_roi) * 1000, 1)

        _t = time.perf_counter()
        # Same first-pass / second-look / recovery as `/v1/groups`. Before this
        # the server took one detector view and accepted whatever it returned:
        # 10 of 20 vertical AI pages on 2026-08-15 came back with zero blocks,
        # which silently became one translation unit per Lens column.
        text_blocks, _tb_pass = detect_blocks_with_second_look(
            detect_text_blocks_in_rois, img, _roi_tree, _rois,
            build_rois=lambda t, w, h: build_vertical_rois(
                t, w, h, margin_ratio=settings.vertical_roi_margin_ratio
            ),
            width=W, height=H, timings=_tb_timings,
        )
        stages["blocks_ms"] = round((time.perf_counter() - _t) * 1000, 1)
        stages["blocks"] = len(text_blocks)
        stages["blocks_second_look"] = str(_tb_pass.get("reason") or "none")
        stages["blocks_initial_outcome"] = str(_tb_pass.get("initialOutcome") or "")
        stages["blocks_stamped"] = int(_tb_pass.get("stamped") or 0)
        stages["blocks_recovered"] = len(_tb_pass.get("recovered") or [])
        stages["blocks_load_ms"] = float(_tb_timings.get("load_ms", 0.0))
        stages["blocks_lock_ms"] = float(_tb_timings.get("lock_ms", 0.0))
        stages["blocks_infer_ms"] = float(_tb_timings.get("infer_ms", 0.0))
        # Which path actually ran — never leave "ROI on but full page ran"
        # invisible, or a before/after benchmark means nothing.
        stages["roi_reason"] = str(_tb_timings.get("roi_reason", ""))
        stages["roi_candidates"] = int(_tb_timings.get("roi_candidates", 0))
        stages["roi_calls"] = int(_tb_timings.get("roi_calls", 0))
    elif wants_ai:
        text_blocks = []
        stages["blocks_ms"] = 0.0
        stages["blocks"] = 0
        stages["blocks_load_ms"] = 0.0
        stages["blocks_lock_ms"] = 0.0
        stages["blocks_infer_ms"] = 0.0

    original_span_tokens = flatten_spans(original_tree)

    # Fast Lens-direct text path.
    # For original/translated we trust Lens paragraph/item geometry and only
    # render that structure. No ONNX annotation, no bubble detector, no custom
    # block grouping. Optionally erase Lens boxes and encode a clean background
    # for the browser overlay.
    if not needs_self_blocks:
        base_img = img
        _t = time.perf_counter()
        _CPU_GATE.acquire()
        stages["gate_wait_ms"] = round((time.perf_counter() - _t) * 1000, 1)
        try:
            _t = time.perf_counter()
            if client_background:
                # The client paints the background. Skipping the inpaint here
                # is the point of the mode — the boxes go out instead.
                out["eraseBoxes"] = erase_boxes_mod.build(original_span_tokens)
            elif settings.lens_direct_erase and original_span_tokens:
                base_img = erase_text_with_boxes(img, original_span_tokens)
            stages["erase_ms"] = round((time.perf_counter() - _t) * 1000, 1)
            stages["bubble_ms"] = 0.0

            # Cheap text-light annotation only; it uses Lens boxes and the
            # current background image, not any locally detected blocks.
            #
            # In client-background mode nothing has been erased yet, so this
            # samples the ORIGINAL pixels — glyphs included — and a dense dark
            # paragraph can read darker than its bubble really is. Logged
            # rather than left to be discovered: it is the one quality
            # difference between the two background modes.
            stages["text_light_source"] = "original" if client_background else "erased"
            _annotate_text_light(original_tree, base_img)
            _annotate_text_light(translated_tree, base_img)

            # The canonical document: paragraphs, text and the geometry needed
            # to draw them, with none of Lens's protobuf field names. This is
            # what the extension will render from once it owns the renderer;
            # emitting it now lets that be built and compared side by side.
            if want_lens_document:
                out["lensDocument"] = lens_document.build(
                    original_tree,
                    translated_tree,
                    width=W,
                    height=H,
                    source_lang=str(data.get("originalContentLanguage") or ""),
                    target_lang=target_lang,
                )
        finally:
            _CPU_GATE.release()

        # Optional fast AI path: translate text, then patch AI wording into
        # Lens's own template geometry.  This avoids ONNX entirely for
        # same-orientation jobs.
        _ai_is_local = bool(ai_cfg) and (
            is_local_provider(ai_cfg.provider)
            or any(h in (ai_cfg.base_url or "").lower()
                   for h in ("localhost", "127.0.0.1", "0.0.0.0"))
        )
        _run_ai = bool(wants_ai and ai_cfg and ((ai_cfg.api_key or "").strip() or _ai_is_local))
        _f_ai: concurrent.futures.Future | None = None
        _ai_executor: concurrent.futures.ThreadPoolExecutor | None = None
        _t_ai_submit = time.perf_counter()
        # Group and normalise a private presentation copy even when AI is off:
        # Translated HTML itself must not inherit Lens's unstable +/-90 sign.
        group_paragraphs_into_bubbles(original_tree, W, H, base_img=base_img)
        group_paragraphs_into_bubbles(translated_tree, W, H, base_img=base_img)
        translated_tree, _rotation_stats = presentation_rotation_copy(translated_tree)
        stages["rotation_signs"] = {"translated": _rotation_stats}
        stages["rotation_flips"] = _rotation_stats["flips"]
        if _run_ai:
            # Group paragraphs into speech bubbles BEFORE the model sees them.
            #
            # Lens returns a bubble as one paragraph per LINE (and, for vertical
            # Japanese, per column). `_run_ai_layer` builds one translation unit
            # per `bubble_groups` entry and falls back to one-per-paragraph when
            # the tree has no groups — and on this branch nothing had grouped it,
            # so that fallback was always what ran.
            #
            # Measured 2026-08-07: `ai.groups n_groups: 12, n_paras: 12` on a page
            # holding six bubbles. Two costs, both paid every time:
            #   * the model answers twelve times instead of six — ai_ms 2.4s → 18.3s
            #   * it translates half-sentences with no context, so "でもまずは
            #     自分の人生を" comes back as a finished sentence when it is half
            #     of one
            #
            # It is arithmetic on boxes that already exist (`blocks_ms` is 0.0 on
            # this branch), so the only reason it was missing is that the call
            # lived in the other branch.
            # Presentation geometry is a private copy.  Original stays exactly
            # as Lens decoded it, and the AI worker and HTML renderer share one
            # already-normalised immutable template instead of racing a later
            # in-place fix on translated_tree.
            dbg(
                "groups.pre_ai",
                {
                    "paras": len(original_tree.get("paragraphs") or []),
                    "bubble_groups": len(original_tree.get("bubble_groups") or []),
                },
            )
            ai_original_tree = copy.deepcopy(original_tree)
            ai_translated_tree = copy.deepcopy(translated_tree)
            _ai_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            _f_ai = _ai_executor.submit(
                _run_ai_layer,
                out, ai_original_tree, ai_translated_tree, ai_cfg, target_lang, W, H, thai_font, latin_font,
                base_img=base_img,
                vision_img=img,
                capture_request=capture_ai_request,
                use_lens_template=True,
                layout_meta=ai_layout_meta,
            )

        _t = time.perf_counter()
        _CPU_GATE.acquire()
        stages["gate_wait_ms"] = stages.get("gate_wait_ms", 0.0) + round((time.perf_counter() - _t) * 1000, 1)
        try:
            _t = time.perf_counter()
            fit_tree_font_sizes(original_tree, thai_font, latin_font, W, H)
            out["original"]["originalhtml"] = render_tree_overlay(original_tree, W, H)
            fit_tree_font_sizes(translated_tree, thai_font, latin_font, W, H)
            out["translated"]["translatedhtml"] = render_tree_overlay(translated_tree, W, H)
            out["htmlCss"] = overlay_css()
            out["htmlMeta"] = {"baseW": int(W), "baseH": int(H), "format": "tp", "path": stages.get("pipeline_path", "lens_direct")}
            stages["render_ms"] = round((time.perf_counter() - _t) * 1000, 1)

            if client_background:
                # No re-encode, no base64: the largest field in the response
                # simply does not exist in this mode.
                stages["png_ms"] = 0.0
            elif settings.lens_direct_png:
                _t = time.perf_counter()
                out["imageDataUri"] = _encode_bg_data_uri(base_img)
                stages["png_ms"] = round((time.perf_counter() - _t) * 1000, 1)
            else:
                stages["png_ms"] = 0.0
        finally:
            _CPU_GATE.release()

        if _f_ai is not None:
            try:
                _f_ai.result()
            finally:
                _ai_executor.shutdown(wait=False)  # type: ignore[union-attr]
            stages["ai_ms"] = round((time.perf_counter() - _t_ai_submit) * 1000, 1)
            # The background was encoded above while the model was still
            # answering, so this runs after the join and re-encodes only when
            # the answer actually came back short.
            _restore_unanswered_paragraphs(
                out, original_tree, img, base_img,
                client_background=client_background, stages=stages,
            )
            # The AI layer's own per-line geometry, now that it exists. Without
            # it the client renderer refuses the "ai" source on any page with a
            # multi-line bubble — which is every page — and silently falls back
            # to the server's markup, so the local renderer never ran at all.
            _attached = lens_document.attach_ai_layer(
                out.get("lensDocument"), (out.get("Ai") or {}).get("aiTree")
            )
            stages["doc_ai_paras"] = _attached
        else:
            stages.setdefault("ai_ms", 0.0)
        return out

    # ONNX already done in Phase 1 — annotate trees now.
    # Text-block detection ran on the ORIGINAL image (text present), and
    # OUTSIDE the CPU gate: inference is serialised by the detector's own
    # lock, so holding a gate slot here would only starve other jobs' erase /
    # bubble / png work (measured: gate_wait_ms ballooned to 8 s in batches).
    # When the model is loaded it is the SOLE grouping authority for vertical
    # text; the geometric rules run only as a loudly-flagged fallback.
    tb_authority = textblocks_available()
    if tb_authority:
        annotate_paragraph_blocks(original_tree, text_blocks)
        annotate_paragraph_blocks(translated_tree, text_blocks)
        # Observability: expose what the model saw. Debug dumps of the
        # trees then show the detected regions next to each paragraph's
        # _tb_block assignment, so grouping decisions can be audited.
        original_tree["text_blocks_px"] = [list(b) for b in text_blocks]
        translated_tree["text_blocks_px"] = [list(b) for b in text_blocks]
    else:
        _warn_textblocks_fallback()

    # --- Erase + bubble detect (BEFORE AI / render) ------------------------
    # Order matters: the bubble detector needs an inpainted image to find
    # the real bubble outline (not just the text-AABB), and the AI patch
    # needs the bubble bounds attached to the template tree so it can
    # render the translation in the *bubble* shape — vital for the
    # source-vertical → target-horizontal case (Japanese → Thai) where a
    # text-only AABB is far too narrow.
    _t = time.perf_counter()
    _CPU_GATE.acquire()
    stages["gate_wait_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    try:
        _t = time.perf_counter()
        if original_span_tokens:
            base_img = erase_text_with_boxes(img, original_span_tokens)
        else:
            base_img = img
        stages["erase_ms"] = round((time.perf_counter() - _t) * 1000, 1)

        _t = time.perf_counter()
        bubble_map = detect_bubble_bounds_combined(
            base_img, original_tree.get("paragraphs") or [], W, H
        )
        stages["bubble_ms"] = round((time.perf_counter() - _t) * 1000, 1)
        attach_bubble_bounds(original_tree, bubble_map)
        attach_bubble_bounds(translated_tree, bubble_map)
        dbg("bubble.detected", {"paragraphs": len(bubble_map), "hits": sum(1 for v in bubble_map.values() if v)})

        # Group paragraphs into bubble_groups for all trees so every downstream
        # consumer (renderer, patcher, debug export) sees the same structure.
        # This runs once here; the renderer reads tree["bubble_groups"] directly.
        # base_img (erased) enables the ink-barrier veto used by the
        # geometric fallback; under model authority the detected text blocks
        # alone decide vertical grouping.
        group_paragraphs_into_bubbles(
            original_tree, W, H, base_img=base_img, tb_authority=tb_authority
        )
        group_paragraphs_into_bubbles(
            translated_tree, W, H, base_img=base_img, tb_authority=tb_authority
        )
        dbg("groups.original", {"bubble_groups": len(original_tree.get("bubble_groups") or [])})
        dbg("groups.translated", {"bubble_groups": len(translated_tree.get("bubble_groups") or [])})

        # Furigana readings dropped from the translation text. Zero on a page
        # that clearly has readings means the reading is still glued to the run
        # it annotates, and whatever translates that string will return noise.
        stages["ruby_items_dropped"] = sum(
            int(bg.get("ruby_items_dropped") or 0)
            for tree in (original_tree, translated_tree)
            for bg in (tree.get("bubble_groups") or [])
        )

        # Give groups the model's block rect when OpenCV found no balloon.
        # Without this the relayout canvas falls back to the union of the
        # source items, which for vertical text is a tall narrow strip — the
        # horizontal translation then wraps to one or two characters per line.
        if tb_authority and text_blocks:
            _n_og = attach_block_bounds_to_groups(
                original_tree, text_blocks, W, H
            )
            _n_tr = attach_block_bounds_to_groups(
                translated_tree, text_blocks, W, H
            )
            stages["group_bounds_from_blocks"] = _n_og + _n_tr

        # Two groups handed the SAME canvas are one bubble that the paragraph
        # merge split; left alone they render two overlays at identical
        # coordinates and one hides the other. Runs unconditionally: the shared
        # rect can just as easily come from one OpenCV balloon covering two
        # detected regions, which happens whether or not the model ran.
        _m_og = merge_groups_sharing_canvas(original_tree, W, H)
        _m_tr = merge_groups_sharing_canvas(translated_tree, W, H)
        stages["group_canvas_merged"] = _m_og["merged"] + _m_tr["merged"]
        stages["group_canvas_unshared"] = (
            _m_og["unshared"] + _m_tr["unshared"]
        )

        # Columns of one bubble that Lens decoded as +90 and -90 render facing
        # opposite ways. Snap each group to one sign before anything renders.
        # Presentation normalisation belongs to the translated copy only.
        # Original remains the byte-for-byte Lens geometry the user selected.
        _rotation_stats: dict[str, int] = {}
        stages["rotation_flips"] = normalize_group_rotation_signs(
            translated_tree, stats=_rotation_stats
        )
        stages["rotation_signs"] = {"translated": _rotation_stats}

        # --- Translated relayout ------------------------------------------
        # Rebuild the MT layer with boxes at the target orientation, using the
        # translated tree's OWN groups and OWN text.  Nothing is translated
        # again — this is pure geometry, so it costs no provider call and works
        # without an API key.
        #
        # The rebuilt tree is kept in a separate variable: ``translated_tree``
        # still holds Lens's original structure, which the AI layer's marker
        # repair reads paragraph-by-paragraph (relayout drops furigana and
        # 1-character fragments, so its paragraph indices no longer line up).
        if relayout_translated:
            _t = time.perf_counter()
            rebuilt = rebuild_tree_for_target(translated_tree, target_lang, W, H)
            stages["tr_relayout_ms"] = round((time.perf_counter() - _t) * 1000, 1)
            if rebuilt is None:
                # NO-SILENT-FALLBACK: the switch said relayout, the decision
                # said the axis changed, and we still could not rebuild (no
                # usable bubble groups). Rendering the rotated Lens layer is
                # the only option, but it must be visible in the log rather
                # than looking like the relayout simply had no effect.
                relayout_translated = False
                stages["tr_relayout"] = False
                stages["tr_relayout_failed"] = "no_bubble_groups"
                event(
                    "relayout.translated.unavailable",
                    {"reason": "no_bubble_groups", "lang": target_lang},
                    ok=False,
                )
            else:
                translated_render_tree = rebuilt
                stages["tr_relayout_paragraphs"] = len(rebuilt.get("paragraphs") or [])
                dbg("relayout.translated", {"stats": tree_stats(rebuilt), "lang": target_lang})

        # Per-paragraph background luminance → text colour flag, sampled on
        # the erased image (original glyphs removed). Cheap: ≤24x24 median.
        _annotate_text_light(original_tree, base_img)
        _annotate_text_light(translated_tree, base_img)
        if translated_render_tree is not translated_tree:
            _annotate_text_light(translated_render_tree, base_img)
    finally:
        _CPU_GATE.release()

    # =========================================================
    # Phase 2 — AI call || HTML render + PNG encode (independent)
    #
    # After erase/bubble/groups the two remaining slow steps have
    # no dependency on each other:
    #   • AI needs Lens text + ONNX groups (already done above).
    #   • Render+PNG needs the erased image + Lens trees (also done).
    # Running them concurrently saves ~max(render+png=1.5 s, ai=2 s)
    # instead of ai(2 s) + render+png(1.5 s) = 3.5 s. Wall-clock
    # collapses to ~2 s — a 1.5 s saving on every ai job.
    #
    # Thread safety: AI writes out["Ai"] / out["AiTextFull"].
    # Render writes out["original"]["originalhtml"] etc. and
    # out["imageDataUri"].  These are disjoint keys; CPython's GIL
    # makes individual dict __setitem__ atomic, so no lock is needed.
    # =========================================================
    _ai_is_local = bool(ai_cfg) and (
        is_local_provider(ai_cfg.provider)
        or any(h in (ai_cfg.base_url or "").lower()
               for h in ("localhost", "127.0.0.1", "0.0.0.0"))
    )
    # ``wants_ai`` matters here now: this branch used to be reachable only for
    # AI jobs, but a translated-relayout job also lands in it. Without the guard
    # a caller that supplies an AiConfig for a non-AI source (the CLI does) would
    # silently pay for a provider call it never asked for.
    _run_ai = bool(wants_ai and ai_cfg and ((ai_cfg.api_key or "").strip() or _ai_is_local))

    # Submit AI to a background thread so it overlaps with render+PNG below.
    _f_ai: concurrent.futures.Future | None = None
    _ai_executor: concurrent.futures.ThreadPoolExecutor | None = None
    _t_ai_submit = time.perf_counter()
    if _run_ai:
        _ai_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        _f_ai = _ai_executor.submit(
            _run_ai_layer,
            out, original_tree, translated_tree, ai_cfg, target_lang, W, H, thai_font, latin_font,
            base_img=base_img,
            vision_img=img,
            capture_request=capture_ai_request,
            use_lens_template=False,
            layout_meta=ai_layout_meta,
        )

    # HTML render + PNG encode in the main thread while AI runs above.
    # One renderer, one CSS payload, three layers. ``render_tree_overlay``
    # emits one ``<div class="tp-line">`` per Lens item — the browser handles
    # text rendering with whatever Thai/CJK font is installed, no Pillow.
    # ``fit_tree_font_sizes`` here only walks the tree to attach a starting
    # ``font_size_px`` on each item using the closed-form heuristic; the
    # renderer falls back to the same heuristic if a size is missing.
    _t = time.perf_counter()
    _CPU_GATE.acquire()
    stages["gate_wait_ms"] = stages.get("gate_wait_ms", 0.0) + round(
        (time.perf_counter() - _t) * 1000, 1
    )
    try:
        _t = time.perf_counter()
        fit_tree_font_sizes(original_tree, thai_font, latin_font, W, H)
        out["original"]["originalhtml"] = render_tree_overlay(original_tree, W, H)

        # A relaid-out translated tree carries ``side == "Ai"``, which selects
        # the deterministic bubble-block renderer — that is the whole point of
        # rebuilding the geometry — and that path needs ``target_lang`` to pick
        # the reading direction.
        fit_tree_font_sizes(translated_render_tree, thai_font, latin_font, W, H)
        out["translated"]["translatedhtml"] = render_tree_overlay(
            translated_render_tree, W, H, target_lang=target_lang if relayout_translated else ""
        )
        if relayout_translated:
            out["translated"]["translatedTree"] = translated_render_tree
            out["translated"]["relayout"] = {
                "applied": True,
                "source_orientation": tr_layout_meta.get("source_orientation"),
                "target_orientation": tr_layout_meta.get("target_orientation"),
            }

        out["htmlCss"] = overlay_css()
        out["htmlMeta"] = {"baseW": int(W), "baseH": int(H), "format": "tp"}
        stages["render_ms"] = round((time.perf_counter() - _t) * 1000, 1)

        # --- Background -----------------------------------------------------
        # This branch still erases server-side: the bubble detector needs an
        # inpainted image to find the real bubble outline. What it does NOT
        # have to do is re-encode that image and base64 it into the reply —
        # the client can repaint the same boxes over the picture it already
        # has decoded on screen.
        if client_background:
            out["eraseBoxes"] = erase_boxes_mod.build(original_span_tokens)
            stages["png_ms"] = 0.0
        else:
            _t = time.perf_counter()
            out["imageDataUri"] = _encode_bg_data_uri(base_img)
            stages["png_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    finally:
        _CPU_GATE.release()

    # Wait for AI (will be instant if render+PNG took longer than AI).
    if _f_ai is not None:
        try:
            _f_ai.result()  # re-raises any exception from the AI thread
        finally:
            _ai_executor.shutdown(wait=False)  # type: ignore[union-attr]
        stages["ai_ms"] = round((time.perf_counter() - _t_ai_submit) * 1000, 1)
        _restore_unanswered_paragraphs(
            out, original_tree, img, base_img,
            client_background=client_background, stages=stages,
        )

    # Re-group the AI tree after patching (AI text may change para boundaries).
    ai_tree = (out.get("Ai") or {}).get("aiTree")
    if isinstance(ai_tree, dict):
        group_paragraphs_into_bubbles(ai_tree, W, H)
        dbg("groups.ai", {"bubble_groups": len(ai_tree.get("bubble_groups") or [])})

    return out


# --- Payload entry point ---------------------------------------------------

def _extract_image_bytes(payload: dict) -> tuple[bytes, str]:
    """Resolve a payload's image into ``(bytes, mime)``.

    Source priority: explicit ``imageDataUri`` -> ``src`` data URI ->
    download ``src`` (with the page URL as referer).
    """
    src = (payload.get("src") or "").strip()
    if payload.get("imageDataUri"):
        return data_uri_to_bytes(payload["imageDataUri"])
    if src.startswith("data:"):
        return data_uri_to_bytes(src)

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    page_url = str((context or {}).get("page_url") or "").strip()
    return download(src, page_url)


def _build_ai_config(payload: dict, mode: str, source: str) -> AiConfig | None:
    """Build an :class:`AiConfig` from a payload, or ``None`` if not an AI job."""
    ai = payload.get("ai")
    if mode != "lens_text" or source != "ai" or not isinstance(ai, dict):
        return None
    provider = str(ai.get("provider") or "auto").strip() or "auto"
    base_url = str(ai.get("base_url") or "auto").strip() or "auto"
    user_key = str(ai.get("api_key") or "").strip()

    # The server's own key is a LAST resort, and never for a self-hosted
    # endpoint: "localhost" in a payload means the server's localhost, not the
    # user's machine. Which key is in play decides whether a caller-chosen
    # base_url is allowed at all (backend/security.py).
    looks_local = is_local_provider(provider) or any(
        h in base_url.lower() for h in ("localhost", "127.0.0.1", "0.0.0.0", "[::1]")
    )
    api_key = user_key or ("" if looks_local else settings.ai_api_key)

    return AiConfig(
        api_key=api_key,
        user_key=bool(user_key),
        model=str(ai.get("model") or "auto").strip() or "auto",
        provider=provider,
        base_url=base_url,
        prompt_editable=str(ai.get("prompt") or "").strip(),
        glossary=ai.get("glossary") if isinstance(ai.get("glossary"), list) else [],
        characters=ai.get("characters") if isinstance(ai.get("characters"), list) else [],
        char_memory=bool(ai.get("char_memory", True)),
        # False / True / "always" / "auto" — keep the mode string intact.
        send_image=(
            ai.get("send_image").strip().lower()
            if isinstance(ai.get("send_image"), str)
            else bool(ai.get("send_image"))
        ),
        # "default" = model thinks normally; "off" = fastest (Gemini only).
        thinking=str(ai.get("thinking") or "default").strip().lower() or "default",
        # Frozen series context (read-then-translate batches; see ai/brief.py).
        series_state=str(ai.get("series_state") or "").strip(),
        speakers=ai.get("speakers") if isinstance(ai.get("speakers"), dict) else {},
        prev_context=ai.get("prev_context") if isinstance(ai.get("prev_context"), list) else [],
        context_frozen=bool(ai.get("context_frozen", False)),
    )


def _result_worth_caching(mode: str, source: str, out: dict[str, Any]) -> bool:
    """Never cache empty results.

    A transient empty Lens/AI response must not become sticky: a cached empty
    result made the extension silently skip the image ("no text") on every
    retry until the process restarted. Re-running a genuinely textless image
    is cheap compared to that failure mode.
    """
    if mode == "lens_images":
        return bool(out.get("imageDataUri"))
    if source == "ai":
        ai = out.get("Ai") or {}
        return bool(ai.get("aihtml"))
    has_overlay = bool(
        (out.get("original") or {}).get("originalhtml")
        or (out.get("translated") or {}).get("translatedhtml")
    )
    has_text = bool(
        str(out.get("originalTextFull") or "").strip()
        or out.get("originalParagraphs")
        or out.get("translatedParagraphs")
    )
    return has_overlay and has_text


def process_payload(payload: dict) -> dict[str, Any]:
    """Process one queued job payload end to end (with result caching)."""
    t_start = time.perf_counter()
    mode = payload.get("mode") or "lens_images"
    lang = payload.get("lang") or "en"
    source = str(payload.get("source") or "").strip().lower() or "translated"

    # The download / data-URI decode is the first thing that can fail, and it
    # fails before any stage counter inside process_image exists.
    try:
        img_bytes, mime = _extract_image_bytes(payload)
    except BaseException as exc:
        if getattr(exc, "tp_stage", None) is None:
            try:
                exc.tp_stage = "image_fetch"  # type: ignore[attr-defined]
            except Exception:
                pass
        raise
    t_img = time.perf_counter()
    if not img_bytes:
        raise ValueError("No image data")

    ai_cfg = _build_ai_config(payload, mode, source)
    layout = _layout_options(payload)

    # --- cache lookup ------------------------------------------------------
    img_hash = sha256_hex(img_bytes)
    cache_key = ""
    cache_used = False
    if mode in ("lens_images", "lens_text") and img_hash:
        # Cache direct Lens results too. This avoids repeating the Lens round-trip
        # after extension retries/reconnects. AI still gets its separate cache
        # because prompt/model/provider affect the result.
        cache_source = "ai" if source == "ai" else source or "translated"
        # The relayout switches change the rendered geometry, so they MUST be
        # part of the key — otherwise flipping a toggle would serve the old
        # layout back from cache and look like the switch did nothing.
        cache_key = cache_mod.build_cache_key(
            img_hash, lang, mode, cache_source, ai_cfg, layout=layout
        )
        cache = cache_mod.ai_result_cache if source == "ai" else cache_mod.result_cache
        cached = cache.get(cache_key)
        if cached:
            cached["perf"] = {
                "cache": "hit",
                "total_ms": round((time.perf_counter() - t_start) * 1000, 1),
                "img_ms": round((t_img - t_start) * 1000, 1),
            }
            return cached
        cache_used = True

    # --- run the pipeline against a temp file ------------------------------
    suffix = ".png" if (mime or "").endswith("png") else ".jpg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
        f.write(img_bytes)
        tmp_path = f.name
    t_tmp = time.perf_counter()
    try:
        out = process_image(tmp_path, lang, mode, ai_cfg, source=source, layout_opts=layout)
        stages = out.pop("perfStages", {}) or {}
        out["perf"] = {
            "cache": "miss" if cache_used else "off",
            "total_ms": round((time.perf_counter() - t_start) * 1000, 1),
            "img_ms": round((t_img - t_start) * 1000, 1),
            "tmp_ms": round((t_tmp - t_img) * 1000, 1),
            **stages,
        }

        # What the AI layer was actually ASKED to do, and what it did.
        #
        # Without these, "the page-image option does not work" and "the
        # page-image option works and takes 85 seconds" produce identical log
        # lines — and they need opposite responses. `ai_vision` says whether
        # the picture was really attached; `ai_thinking` and `ai_units` say why
        # the call was as expensive as it was.
        if ai_cfg is not None:
            ai_meta = (out.get("Ai") or {}).get("meta") or {}
            out["perf"].update(
                {
                    "ai_send_image": str(getattr(ai_cfg, "send_image", False)),
                    "ai_vision": bool(ai_meta.get("vision")),
                    "ai_thinking": str(getattr(ai_cfg, "thinking", "default")),
                    "ai_model": str(ai_meta.get("model") or ""),
                    # Series memory, which is the other option whose effect is
                    # invisible from outside: these are the fields that grow
                    # the prompt, so they are what explains a slow call.
                    "ai_glossary": len(getattr(ai_cfg, "glossary", None) or []),
                    "ai_characters_in": len(getattr(ai_cfg, "characters", None) or []),
                    "ai_characters_out": len(ai_meta.get("characters") or []),
                    "ai_series_state_chars": len(str(getattr(ai_cfg, "series_state", "") or "")),
                    "ai_flow": str(ai_meta.get("ai_flow") or ""),
                }
            )
        # NO-SILENT-FALLBACK: brief pass-2 jobs ask to reuse pass-1 Lens data
        # (reuse_lens). Server-side reuse is not implemented yet, so the second
        # OCR round-trip must be VISIBLE in translate.perf instead of silent.
        if payload.get("reuse_lens"):
            out["perf"]["lens_reused"] = False
        # One compact perf line per processed job (cache hits don't get here),
        # so slow stages are visible straight from the production logs.
        event("translate.perf", {"mode": mode, "lang": lang, "source": source, **out["perf"]})
        if cache_used and cache_key and _result_worth_caching(mode, source, out):
            cache = cache_mod.ai_result_cache if source == "ai" else cache_mod.result_cache
            cache.set(cache_key, out)
        return out
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
