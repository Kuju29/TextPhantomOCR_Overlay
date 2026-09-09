from __future__ import annotations
from PIL import Image

from typing import Any
import numpy as np

import concurrent.futures, contextlib, copy, io, os, time

from backend.ai.translation.contracts import AiConfig
from backend.config import settings
from backend.jobs.fonts import resolve_font_pair
from backend.jobs.stages.config import layout_options
from backend.jobs.stages import ai_stage, lens_stage, render_stage
from backend.grouping.detector_free_service import (
    group_vertical_lens,
    project_grouping_result,
    bubble_groups_from_result,
)
from backend.grouping.ai_source_tree import build_ai_source_tree
from backend.jobs.runtime import CPU_GATE
from backend.jobs.stage_admission import stage_slot
from backend.jobs.stages.image_prepare import image_to_rgb
from backend.lens import document as lens_document
from backend.lens.languages import normalize as normalize_lang
from backend.ai.rate_policy import is_local_target
from backend.lens.tree import (
    flatten_spans,
    tree_stats,
)
from backend.log import dbg, event
from backend.api.errors import future_result_with_stage
from backend.render.erase import erase_text_with_boxes
from backend.render import erase_boxes as erase_boxes_mod
from backend.render.relayout import (
    relayout_decision,
)
from backend.render.html.translated import render_translated_overlay
from backend.render.translated_groups import translated_document, translated_layout_groups
from backend.render.rotation_signs import (
    presentation_rotation_copy,
)
from backend.render.components.typography import fit_tree_font_sizes
from backend.render.html.css import overlay_css
from backend.render.html.overlay import render_tree_overlay
from backend.utils.images import (
    bytes_to_data_uri,
)

SUPPORTED_MODES = {"lens_images", "lens_text"}

_BG_FORMAT = (os.environ.get("TP_LENS_DIRECT_IMG_FORMAT", "auto") or "auto").strip().lower()
_WEBP_QUALITY = max(1, min(100, int(os.environ.get("TP_LENS_DIRECT_WEBP_QUALITY", "80"))))
_WEBP_METHOD = max(0, min(6, int(os.environ.get("TP_LENS_DIRECT_WEBP_METHOD", "2"))))
_MAX_PALETTE_COLORS = max(2, int(os.environ.get("TP_LENS_DIRECT_COLOR_LIMIT", "256")))
_COLOR_SAMPLE_STEP = max(1, int(os.environ.get("TP_LENS_DIRECT_COLOR_STEP", "3")))
_FLAT_SAMPLE_PX = max(32, int(os.environ.get("TP_LENS_DIRECT_SAMPLE_PX", "256")))
_FLAT_THRESHOLD = min(1.0, max(0.0, float(os.environ.get("TP_LENS_DIRECT_FLAT_THRESHOLD", "0.45"))))

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

    if _is_quantized_art(img):
        return bytes_to_data_uri(_encode_png(img), "image/png")
    return bytes_to_data_uri(_encode_webp(img), "image/webp")

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
    cancel_check=None,
    admission_identity: str = "anon",
    admission_unlimited: bool = False,
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
    layout = layout_opts if isinstance(layout_opts, dict) else layout_options(None)

    client_background = bool(layout.get("client_background")) and mode_id == "lens_text"
    want_lens_document = bool(layout.get("lens_document")) and mode_id == "lens_text"

    wants_ai = (mode_id == "lens_text" and source_id == "ai" and ai_cfg is not None)
    ai_layout_meta: dict[str, Any] = {}
    ai_requires_relayout = False
    relayout_translated = False
    tr_layout_meta: dict[str, Any] = {}

    stages: dict[str, Any] = {"pipeline_path": "lens_direct"}

    with _stage(stages, "image_decode"):
        with Image.open(image_path) as src_img:
            img = image_to_rgb(src_img)
        W, H = img.size
    thai_font, latin_font = resolve_font_pair(target_lang)

    with _stage(stages, "lens_fetch"):
        with stage_slot("lens", admission_identity, unlimited=admission_unlimited):
            data, stages["lens_ms"] = lens_stage.fetch(image_path, target_lang, lens_data)

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
        "backgroundMode": "boxes" if client_background else "image",
    }

    if mode_id == "lens_images":
        out["imageDataUri"] = lens_stage.direct_image(data, image_path)
        return out

    stages["stage"] = "tree_decode"
    original_tree, translated_tree = lens_stage.decode(data, W, H)
    translated_render_tree = translated_tree
    out["original"] = {"originalTree": original_tree, "originalTextFull": out["originalTextFull"] or ""}
    out["translated"] = {
        "translatedTree": translated_tree,
        "translatedTextFull": out["translatedTextFull"] or "",
    }
    dbg("tree.original", tree_stats(original_tree))
    dbg("tree.translated", tree_stats(translated_tree))

    if mode_id == "lens_text" and source_id == "translated":
        relayout_translated, tr_layout_meta = relayout_decision(
            translated_tree, target_lang, enabled=layout["relayout_translated"]
        )
        stages.update(
            {f"tr_{k}": v for k, v in tr_layout_meta.items() if k != "rotation_samples"}
        )
        stages["tr_relayout"] = relayout_translated

    if wants_ai or relayout_translated:
        if wants_ai:
            stages["pipeline_path"] = "lens_graph_ai"
        else:
            stages["pipeline_path"] = "lens_graph_translated"
        out["pipelinePath"] = stages["pipeline_path"]

    original_span_tokens = flatten_spans(original_tree)

    if mode_id == "lens_text":
        base_img = img
        _t = time.perf_counter()
        CPU_GATE.acquire()
        stages["gate_wait_ms"] = round((time.perf_counter() - _t) * 1000, 1)
        try:
            _t = time.perf_counter()
            if client_background:
                out["eraseBoxes"] = erase_boxes_mod.build_for_tree(original_tree)
            elif settings.lens_direct_erase and original_span_tokens:
                base_img = erase_text_with_boxes(img, original_span_tokens)
            stages["erase_ms"] = round((time.perf_counter() - _t) * 1000, 1)
            stages["bubble_ms"] = 0.0

            stages["text_light_source"] = "original" if client_background else "erased"
            render_stage.annotate_text_light(original_tree, base_img)
            render_stage.annotate_text_light(translated_tree, base_img)

            if want_lens_document:
                if source_id == "translated":
                    out["lensDocument"] = lens_document.build_translated(translated_tree,
                        width=W, height=H,
                        source_lang=str(data.get("originalContentLanguage") or ""), target_lang=target_lang)
                else:
                    out["lensDocument"] = lens_stage.build_document(
                        original_tree, translated_tree, W, H,
                        str(data.get("originalContentLanguage") or ""), target_lang,
                    )
        finally:
            CPU_GATE.release()

        _ai_is_local = bool(ai_cfg) and is_local_target(
            ai_cfg.provider, ai_cfg.base_url
        )
        _run_ai = bool(wants_ai and ai_cfg and ((ai_cfg.api_key or "").strip() or _ai_is_local))
        _f_ai: concurrent.futures.Future | None = None
        _ai_executor: concurrent.futures.ThreadPoolExecutor | None = None
        _t_ai_submit = time.perf_counter()
        translated_groups = None
        translated_paragraphs = None
        if source_id == "translated":
            with CPU_GATE:
                translated_paragraphs = translated_document(translated_tree)
                translated_groups = translated_layout_groups(translated_paragraphs, W, H)
            out["translated"]["displayGroups"] = translated_groups
            stages["grouping"] = "translated_geometry_only"
            stages["tr_display_groups"] = len(translated_groups)
        else:
            with _stage(stages, "lens_graph_grouping"):
                # Grouping evidence must use the same untouched page pixels as the
                # Extension route.  The erased render canvas can remove strokes or
                # create whitespace that changes graph boundaries.
                with stage_slot("grouping", admission_identity, unlimited=admission_unlimited):
                    grouped = group_vertical_lens(original_tree, W, H, image=img)
                canonical = grouped["grouping_result"]
                from backend.geometry_diagnostics import emit_group_diagnostics
                emit_group_diagnostics(canonical, W, H)
                ai_source_tree = build_ai_source_tree(original_tree, canonical)
                out["canonicalOriginalTree"] = ai_source_tree
                if wants_ai:
                    ai_requires_relayout, ai_layout_meta = relayout_decision(
                        ai_source_tree, target_lang, enabled=True
                    )
                    ai_layout_meta["grouping"] = "canonical_original_tree"
                    stages["grouping"] = "canonical_original_tree"
                    stages.update({
                        f"ai_{key}": value
                        for key, value in ai_layout_meta.items()
                        if key != "rotation_samples"
                    })
                original_tree["bubble_groups"] = grouped["bubble_groups"]
                if isinstance(out.get("lensDocument"), dict):
                    out["lensDocument"]["canonicalOriginalTree"] = ai_source_tree
                if wants_ai:
                    projected = project_grouping_result(
                        canonical, original_tree, translated_tree)
                    translated_tree["bubble_groups"] = bubble_groups_from_result(
                        projected, translated_tree)
                    if projected.get("rawPartitionHash") != canonical.get("rawPartitionHash"):
                        raise RuntimeError("grouping raw partition parity mismatch")
                    stages["grouping_target_fingerprint"] = projected.get("treeFingerprint")
                stages["grouping_partition_hash"] = canonical.get("rawPartitionHash")
                stages["grouping_tree_fingerprint"] = canonical.get("treeFingerprint")
                stages["grouping_debug"] = grouped["debug"]
        if wants_ai:
            # Preserve the existing AI template contract; never feed it the new
            # translated-only presentation groups or modify raw Translated data.
            translated_tree, _rotation_stats = presentation_rotation_copy(translated_tree)
            stages["rotation_signs"] = {"translated": _rotation_stats}
            stages["rotation_flips"] = _rotation_stats["flips"]
        if _run_ai:
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
                ai_stage.run_ai_layer,
                out, ai_original_tree, ai_translated_tree, ai_cfg, target_lang, W, H, thai_font, latin_font,
                ai_source_tree=ai_source_tree,
                base_img=base_img,
                vision_img=img,
                cancel_check=cancel_check,
                capture_request=capture_ai_request,
                use_lens_template=not ai_requires_relayout,
                layout_meta=ai_layout_meta,
                admission_identity=admission_identity,
                admission_unlimited=admission_unlimited,
            )

        _t = time.perf_counter()
        CPU_GATE.acquire()
        stages["gate_wait_ms"] = stages.get("gate_wait_ms", 0.0) + round((time.perf_counter() - _t) * 1000, 1)
        try:
            _t = time.perf_counter()
            fit_tree_font_sizes(original_tree, W, H)
            out["original"]["originalhtml"] = render_tree_overlay(original_tree, W, H)
            if source_id == "translated":
                out["translated"]["translatedhtml"] = render_translated_overlay(
                    translated_render_tree, W, H, rotate=layout["relayout_translated"],
                    target_lang=target_lang, paragraphs=translated_paragraphs, groups=translated_groups)
                out["translated"]["relayout"] = {"applied": bool(layout["relayout_translated"] and
                    any(g["direction"] == "v" for g in translated_groups) and
                    tr_layout_meta.get("target_orientation") == "h")}
            else:
                fit_tree_font_sizes(translated_render_tree, W, H)
                out["translated"]["translatedhtml"] = render_tree_overlay(translated_render_tree, W, H)
            out["htmlCss"] = overlay_css()
            out["htmlMeta"] = {"baseW": int(W), "baseH": int(H), "format": "tp", "path": stages.get("pipeline_path", "lens_direct")}
            stages["render_ms"] = round((time.perf_counter() - _t) * 1000, 1)

            if client_background:
                stages["png_ms"] = 0.0
            elif settings.lens_direct_png:
                _t = time.perf_counter()
                out["imageDataUri"] = _encode_bg_data_uri(base_img)
                stages["png_ms"] = round((time.perf_counter() - _t) * 1000, 1)
            else:
                stages["png_ms"] = 0.0
        finally:
            CPU_GATE.release()

        if _f_ai is not None:
            try:
                future_result_with_stage(_f_ai, "provider_request")
            finally:
                _ai_executor.shutdown(wait=False)  # type: ignore[union-attr]
            stages["ai_ms"] = round((time.perf_counter() - _t_ai_submit) * 1000, 1)
            # _restore_unanswered_paragraphs(
            #     out, original_tree, img, base_img,
            #     client_background=client_background, stages=stages,
            # )
            _attached = lens_document.attach_ai_layer(
                out.get("lensDocument"), (out.get("Ai") or {}).get("aiTree")
            )
            stages["doc_ai_paras"] = _attached
        else:
            stages.setdefault("ai_ms", 0.0)
        return out
