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

import io
import os
import tempfile
import time
from typing import Any

from PIL import Image

from backend.ai import markers
from backend.ai.translate import AiConfig, translate as ai_translate
from backend.config import settings
from backend.jobs import cache as cache_mod
from backend.jobs.fonts import resolve_font_pair
from backend.lens import client as lens_client
from backend.lens.languages import normalize as normalize_lang
from backend.ai.providers import is_local_provider
from backend.lens.tree import decode_tree, flatten_spans, paragraph_texts, tree_stats
from backend.log import dbg, event
from backend.render.bubble import attach_bubble_bounds, detect_bubble_bounds_combined
from backend.render.erase import erase_text_with_boxes
from backend.render.groups import group_paragraphs_into_bubbles
from backend.render.build_ai_tree import build_ai_tree
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


# --- AI layer --------------------------------------------------------------

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
    capture_request: bool = False,
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
        for i, t in enumerate(src_paras_raw):
            group_para_indices.append([i])
            merged_src_paras.append(t)

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

    # First attempt; retry once (with runaway-repeat clamping) if markers drop.
    result = ai_translate(
        src_text, target_lang, ai_cfg,
        capture_request=capture_request,
    )
    first_attempt = result
    retried = False
    if merged_src_paras and markers.needs_retry(str(result.get("aiTextFull") or ""), n_src):
        retried = True
        dbg("ai.retry", {"expected_paras": n_src})
        retry_text = markers.apply(
            [markers.clamp_runaway_repeats(p) for p in merged_src_paras]
        ) or src_text
        result = ai_translate(
            retry_text, target_lang, ai_cfg, is_retry=True,
            capture_request=capture_request,
        )

    ai_text_full = str(result.get("aiTextFull") or "")
    meta = dict(result.get("meta") or {})

    # When the request was captured for debugging, keep BOTH attempts so we
    # can compare the truncated/dropped first attempt to the retry.
    if capture_request and retried:
        first_meta = first_attempt.get("meta") or {}
        meta["debug_request_first"] = first_meta.get("debug_request")
        meta["debug_response_raw_first"] = first_meta.get("debug_response_raw")
        meta["debug_first_attempt_text"] = str(first_attempt.get("aiTextFull") or "")

    # If markers are still incomplete, repair using the translated layer.
    if merged_src_paras and not markers.has_complete_sequence(ai_text_full, n_src):
        # Build group-level fallback texts from the translated tree.
        trans_paras_raw = paragraph_texts(translated_tree or {})
        fallback_texts: list[str] = []
        for idxs in group_para_indices:
            txts = [
                trans_paras_raw[i] if 0 <= i < len(trans_paras_raw) else ""
                for i in idxs
            ]
            fallback_texts.append("".join(t for t in txts if t).strip())
        ai_text_full, repair_meta = markers.repair_with_fallback(
            ai_text_full, n_src, fallback_texts
        )
        meta.update(repair_meta)
        dbg("ai.marker.repaired", repair_meta)

    dbg("ai.groups", {"n_groups": n_src, "n_paras": len(src_paras_raw)})

    # Extract per-group translated texts.
    extracted = markers.extract_paragraphs(ai_text_full, n_src)
    if extracted is not None:
        ai_group_texts, ai_text_full_clean = extracted
    else:
        ai_group_texts = (ai_text_full or "").split("\n\n")
        if len(ai_group_texts) < n_src:
            ai_group_texts += [""] * (n_src - len(ai_group_texts))
        ai_text_full_clean = "\n\n".join(ai_group_texts[:n_src])

    # Build the AI tree fresh from bubble geometry + target language direction.
    # Each bubble group becomes ONE paragraph in the AI tree with item boxes
    # whose orientation matches the target language (horizontal for Thai/Latin,
    # vertical for CJK).  This replaces the old approach of copying geometry
    # from the Lens Translated tree (which kept source-language rotation).
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
    lens_data: dict[str, Any] | None = None,
    capture_ai_request: bool = False,
) -> dict[str, Any]:
    """Run the full pipeline on a local image file.

    ``lens_data`` may be passed in to skip the Google Lens fetch — useful for
    the local CLI (``backend.cli``), which can save and replay a Lens response
    so the Lens round-trip isn't repeated on every run.
    """
    mode_id = mode if mode in SUPPORTED_MODES else "lens_images"
    target_lang = normalize_lang(lang)

    # Per-stage wall-clock timings (ms), surfaced via the translate.perf log
    # line so slow jobs can be diagnosed from the logs alone.
    stages: dict[str, float] = {}
    _t = time.perf_counter()

    data = lens_data if isinstance(lens_data, dict) else lens_client.fetch_lens_data(
        image_path, target_lang, settings.firebase_url
    )
    stages["lens_ms"] = round((time.perf_counter() - _t) * 1000, 1)
    if not isinstance(data, dict):
        data = {}

    img = Image.open(image_path).convert("RGB")
    W, H = img.size
    thai_font, latin_font = resolve_font_pair(target_lang)

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
    original_tree = decode_tree(
        out["originalParagraphs"], out["originalTextFull"] or "", "original", W, H
    )
    translated_tree = decode_tree(
        out["translatedParagraphs"], out["translatedTextFull"] or "", "translated", W, H
    )
    out["original"] = {"originalTree": original_tree, "originalTextFull": out["originalTextFull"] or ""}
    out["translated"] = {
        "translatedTree": translated_tree,
        "translatedTextFull": out["translatedTextFull"] or "",
    }
    dbg("tree.original", tree_stats(original_tree))
    dbg("tree.translated", tree_stats(translated_tree))

    original_span_tokens = flatten_spans(original_tree)

    # --- Erase + bubble detect (BEFORE AI / render) ------------------------
    # Order matters: the bubble detector needs an inpainted image to find
    # the real bubble outline (not just the text-AABB), and the AI patch
    # needs the bubble bounds attached to the template tree so it can
    # render the translation in the *bubble* shape — vital for the
    # source-vertical → target-horizontal case (Japanese → Thai) where a
    # text-only AABB is far too narrow.
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
    group_paragraphs_into_bubbles(original_tree, W, H)
    group_paragraphs_into_bubbles(translated_tree, W, H)
    dbg("groups.original", {"bubble_groups": len(original_tree.get("bubble_groups") or [])})
    dbg("groups.translated", {"bubble_groups": len(translated_tree.get("bubble_groups") or [])})

    # --- optional AI layer -------------------------------------------------
    # ``patch`` deep-copies the chosen template tree, so the bubble bounds
    # AND bubble_groups we just computed propagate into the AI tree automatically.
    # Run the AI layer when we have a key OR when the target is a local,
    # self-hosted provider (Ollama / LM Studio / vLLM / …) which needs no key.
    _ai_is_local = bool(ai_cfg) and (
        is_local_provider(ai_cfg.provider)
        or any(h in (ai_cfg.base_url or "").lower()
               for h in ("localhost", "127.0.0.1", "0.0.0.0"))
    )
    if ai_cfg and ((ai_cfg.api_key or "").strip() or _ai_is_local):
        _t = time.perf_counter()
        _run_ai_layer(
            out, original_tree, translated_tree, ai_cfg, target_lang, W, H, thai_font, latin_font,
            capture_request=capture_ai_request,
        )
        stages["ai_ms"] = round((time.perf_counter() - _t) * 1000, 1)

    # Re-group the AI tree after patching (AI text may change para boundaries).
    ai_tree = (out.get("Ai") or {}).get("aiTree")
    if isinstance(ai_tree, dict):
        group_paragraphs_into_bubbles(ai_tree, W, H)
        dbg("groups.ai", {"bubble_groups": len(ai_tree.get("bubble_groups") or [])})

    # --- HTML overlays --------------------------------------------------
    # One renderer, one CSS payload, three layers. ``render_tree_overlay``
    # emits one ``<div class="tp-line">`` per Lens item — the browser handles
    # text rendering with whatever Thai/CJK font is installed, no Pillow.
    # ``fit_tree_font_sizes`` here only walks the tree to attach a starting
    # ``font_size_px`` on each item using the closed-form heuristic; the
    # renderer falls back to the same heuristic if a size is missing.
    _t = time.perf_counter()
    fit_tree_font_sizes(original_tree, thai_font, latin_font, W, H)
    out["original"]["originalhtml"] = render_tree_overlay(original_tree, W, H)

    fit_tree_font_sizes(translated_tree, thai_font, latin_font, W, H)
    out["translated"]["translatedhtml"] = render_tree_overlay(translated_tree, W, H)

    out["htmlCss"] = overlay_css()
    out["htmlMeta"] = {"baseW": int(W), "baseH": int(H), "format": "tp"}
    stages["render_ms"] = round((time.perf_counter() - _t) * 1000, 1)

    # --- Image data URI (already erased above) -----------------------------
    _t = time.perf_counter()
    buf = io.BytesIO()
    # compress_level=1: measured png_ms was 0.4-3.8 s at the default level 6;
    # level 1 encodes ~5x faster, image quality is identical (PNG is lossless).
    base_img.save(buf, format="PNG", compress_level=1)
    out["imageDataUri"] = bytes_to_data_uri(buf.getvalue(), "image/png")
    stages["png_ms"] = round((time.perf_counter() - _t) * 1000, 1)

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
    api_key = str(ai.get("api_key") or "").strip() or settings.ai_api_key
    return AiConfig(
        api_key=api_key,
        model=str(ai.get("model") or "auto").strip() or "auto",
        provider=str(ai.get("provider") or "auto").strip() or "auto",
        base_url=str(ai.get("base_url") or "auto").strip() or "auto",
        prompt_editable=str(ai.get("prompt") or "").strip(),
        glossary=ai.get("glossary") if isinstance(ai.get("glossary"), list) else [],
    )


def process_payload(payload: dict) -> dict[str, Any]:
    """Process one queued job payload end to end (with result caching)."""
    t_start = time.perf_counter()
    mode = payload.get("mode") or "lens_images"
    lang = payload.get("lang") or "en"
    source = str(payload.get("source") or "").strip().lower() or "translated"

    img_bytes, mime = _extract_image_bytes(payload)
    t_img = time.perf_counter()
    if not img_bytes:
        raise ValueError("No image data")

    ai_cfg = _build_ai_config(payload, mode, source)

    # --- cache lookup ------------------------------------------------------
    img_hash = sha256_hex(img_bytes)
    cache_key = ""
    cache_used = False
    if mode == "lens_text" and img_hash:
        cache_source = "ai" if source == "ai" else "text"
        cache_key = cache_mod.build_cache_key(img_hash, lang, mode, cache_source, ai_cfg)
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
        out = process_image(tmp_path, lang, mode, ai_cfg)
        stages = out.pop("perfStages", {}) or {}
        out["perf"] = {
            "cache": "miss" if cache_used else "off",
            "total_ms": round((time.perf_counter() - t_start) * 1000, 1),
            "img_ms": round((t_img - t_start) * 1000, 1),
            "tmp_ms": round((t_tmp - t_img) * 1000, 1),
            **stages,
        }
        # One compact perf line per processed job (cache hits don't get here),
        # so slow stages are visible straight from the production logs.
        event("translate.perf", {"mode": mode, "lang": lang, "source": source, **out["perf"]})
        if cache_used and cache_key:
            cache = cache_mod.ai_result_cache if source == "ai" else cache_mod.result_cache
            cache.set(cache_key, out)
        return out
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
