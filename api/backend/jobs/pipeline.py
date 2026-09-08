"""Queued-job orchestration: payload, cache, image flow, result."""

from __future__ import annotations

from typing import Any

import time

from backend import cancellation
from backend.jobs import cache as cache_mod
from backend.jobs.stages.config import build_ai_config, layout_options
from backend.jobs.stages.image_flow import process_image
from backend.jobs.stages.payload_io import extract_image_bytes, temporary_image_file
from backend.jobs.stages.result import attach_ai_performance, result_worth_caching
from backend.log import event
from backend.utils.images import sha256_hex

from backend.ai.accounting import api_pipeline_scope

@api_pipeline_scope
def process_payload(payload: dict) -> dict[str, Any]:
    """Process one queued job payload end to end (with result caching)."""
    t_start = time.perf_counter()
    mode = payload.get("mode") or "lens_images"
    lang = payload.get("lang") or "en"
    source = str(payload.get("source") or "").strip().lower() or "translated"
    cancel_check = lambda: cancellation.is_cancelled(payload)
    if cancel_check():
        raise RuntimeError("cancelled")

    # The download / data-URI decode is the first thing that can fail, and it
    # fails before any stage counter inside process_image exists.
    try:
        img_bytes, mime = extract_image_bytes(payload)
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
    if cancel_check():
        raise RuntimeError("cancelled")

    ai_cfg = build_ai_config(payload, mode, source)
    layout = layout_options(payload)

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
        if cancel_check():
            raise RuntimeError("cancelled")
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
    with temporary_image_file(img_bytes, mime) as tmp_path:
        t_tmp = time.perf_counter()
        if cancel_check():
            raise RuntimeError("cancelled")
        out = process_image(tmp_path, lang, mode, ai_cfg, source=source,
                            layout_opts=layout, cancel_check=cancel_check)
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
            attach_ai_performance(out["perf"], out, ai_cfg)
        # NO-SILENT-FALLBACK: brief pass-2 jobs ask to reuse pass-1 Lens data
        # (reuse_lens). Server-side reuse is not implemented yet, so the second
        # OCR round-trip must be VISIBLE in translate.perf instead of silent.
        if payload.get("reuse_lens"):
            out["perf"]["lens_reused"] = False
        # One compact perf line per processed job (cache hits don't get here),
        # so slow stages are visible straight from the production logs.
        event("translate.perf", {"mode": mode, "lang": lang, "source": source, **out["perf"]})
        if cancel_check():
            event("translate.cancelled", {
                "cancelRequestedAt": time.time(), "staleDrawPrevented": True,
            })
            raise RuntimeError("cancelled")
        if cache_used and cache_key and result_worth_caching(mode, source, out):
            cache = cache_mod.ai_result_cache if source == "ai" else cache_mod.result_cache
            cache.set(cache_key, out)
        return out
