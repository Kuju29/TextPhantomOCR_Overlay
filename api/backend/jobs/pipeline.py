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
import io
import os
import tempfile
import threading
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
from backend.render.colors import region_is_dark
from backend.render.textblocks import (
    annotate_paragraph_blocks,
    available as textblocks_available,
    detect_text_blocks,
)
from backend.render.erase import erase_text_with_boxes
from backend.render.groups import group_paragraphs_into_bubbles
from backend.render.build_ai_tree import build_ai_tree
from backend.render.region import LANGUAGE_DIRECTION
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

# --- Background-image encoding ----------------------------------------------
# The erased background does not need to be lossless. Scanned/JPEG-sourced
# pages carry sensor+compression noise that PNG must encode exactly (multi-MB
# payloads); WebP q80 discards it and is typically several times smaller.
# Clean digital pages with large flat areas can go the other way, so BOTH are
# encoded and the smaller one wins — the result payload is never worse than
# the old PNG-only behaviour. TP_LENS_DIRECT_IMG_FORMAT=png forces PNG only.
_BG_FORMAT = (os.environ.get("TP_LENS_DIRECT_IMG_FORMAT", "auto") or "auto").strip().lower()
_WEBP_QUALITY = max(1, min(100, int(os.environ.get("TP_LENS_DIRECT_WEBP_QUALITY", "80"))))


def _encode_bg_data_uri(img: Image.Image) -> str:
    """Encode the (erased) background image as a compact data URI."""
    png_buf = io.BytesIO()
    img.save(png_buf, format="PNG", compress_level=1)
    png_bytes = png_buf.getvalue()
    if _BG_FORMAT == "png":
        return bytes_to_data_uri(png_bytes, "image/png")
    try:
        webp_buf = io.BytesIO()
        img.save(webp_buf, format="WEBP", quality=_WEBP_QUALITY, method=2)
        webp_bytes = webp_buf.getvalue()
        if len(webp_bytes) < len(png_bytes):
            return bytes_to_data_uri(webp_bytes, "image/webp")
    except Exception:
        pass  # Pillow without WebP support — PNG below.
    return bytes_to_data_uri(png_bytes, "image/png")


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


def _target_orientation_for_lang(target_lang: str) -> str:
    """Return the renderer orientation wanted by *target_lang* (``h``/``v``).

    This mirrors ``build_ai_tree``: CJK/``auto`` targets default to vertical;
    Thai/Latin and unknown languages stay horizontal.
    """
    lang_norm = normalize_lang(target_lang)
    preset = LANGUAGE_DIRECTION.get(lang_norm, "")
    if preset in ("h", "hr"):
        return "h"
    if preset in ("v", "auto"):
        return "v"
    return "h"


def _source_orientation_from_lens_tree(tree: dict | None) -> tuple[str, dict[str, Any]]:
    """Classify Lens source layout as horizontal or vertical from item geometry.

    The detector is intentionally cheap and uses only Lens geometry.  It does
    not run ONNX.  Axis-aligned items within ~12 degrees of 0/90 vote; if
    rotation is missing, a tall/narrow ``bounds_px`` item can vote vertical.
    """
    n_h = n_v = n_axis = n_items = 0
    rot_samples: list[float] = []
    if isinstance(tree, dict):
        for para in tree.get("paragraphs") or []:
            if not isinstance(para, dict):
                continue
            for it in para.get("items") or []:
                if not isinstance(it, dict) or not str(it.get("text") or "").strip():
                    continue
                n_items += 1
                box = it.get("box") or {}
                try:
                    rot = float(box.get("rotation_deg") or box.get("rotation_deg_css") or 0.0)
                except Exception:
                    rot = 0.0
                rot_samples.append(rot)
                residual = ((rot + 45.0) % 90.0) - 45.0
                if abs(residual) <= 12.0:
                    n_axis += 1
                    r_mod = rot % 180.0
                    if r_mod > 90.0:
                        r_mod -= 180.0
                    if abs(r_mod) > 45.0:
                        n_v += 1
                    else:
                        n_h += 1
                    continue
                # Fallback for Lens payloads whose rotation is missing but
                # bounds show a clear portrait text item.
                bpx = it.get("bounds_px")
                if isinstance(bpx, (list, tuple)) and len(bpx) == 4:
                    try:
                        w = float(bpx[2]) - float(bpx[0])
                        h = float(bpx[3]) - float(bpx[1])
                    except Exception:
                        w = h = 0.0
                    if w > 0 and h > 2.2 * w:
                        n_axis += 1
                        n_v += 1
    orient = "v" if n_axis > 0 and n_v * 2 >= n_axis else "h"
    return orient, {
        "source_orientation": orient,
        "source_axis_items": n_axis,
        "source_vertical_items": n_v,
        "source_horizontal_items": n_h,
        "source_items": n_items,
        "rotation_samples": [round(x, 1) for x in rot_samples[:12]],
    }


def _should_use_onnx_for_ai(
    original_tree: dict | None,
    translated_tree: dict | None,  # noqa: ARG001 - reserved for future geometry quality checks
    target_lang: str,
) -> tuple[bool, dict[str, Any]]:
    """Decide whether ``lens_text.ai`` really needs the ONNX self-block path.

    Policy:
      * ``TP_AI_LAYOUT_MODE=fast``    -> never run ONNX; patch AI into Lens geometry.
      * ``TP_AI_LAYOUT_MODE=quality`` -> always run ONNX.
      * ``auto`` (default)            -> run ONNX only when source and target
        reading orientations differ, e.g. vertical Japanese -> horizontal Thai
        or horizontal English -> vertical Japanese.

    Horizontal -> horizontal AI now stays on the fast Lens-template path.
    """
    mode = (getattr(settings, "ai_layout_mode", "auto") or "auto").strip().lower()
    source_orientation, meta = _source_orientation_from_lens_tree(original_tree)
    target_orientation = _target_orientation_for_lang(target_lang)
    meta["target_orientation"] = target_orientation
    meta["ai_layout_mode"] = mode
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
            except Exception:
                pass  # vision is best-effort; translation continues text-only

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
) -> dict[str, Any]:
    """Run the full pipeline on a local image file.

    ``lens_data`` may be passed in to skip the Google Lens fetch — useful for
    the local CLI (``backend.cli``), which can save and replay a Lens response
    so the Lens round-trip isn't repeated on every run.
    """
    mode_id = mode if mode in SUPPORTED_MODES else "lens_images"
    source_id = str(source or "translated").strip().lower() or "translated"
    target_lang = normalize_lang(lang)

    # IMPORTANT pipeline contract:
    #   * lens_images                 -> Lens-direct image result
    #   * lens_text.original          -> Lens-direct OCR/layout overlay
    #   * lens_text.translated        -> Lens-direct translated layout overlay
    #   * lens_text.ai                -> AUTO:
    #       - same orientation        -> fast Lens-template AI, no ONNX
    #       - direction changed       -> self-built block path with ONNX
    wants_ai = (mode_id == "lens_text" and source_id == "ai" and ai_cfg is not None)
    needs_self_blocks = False
    ai_layout_meta: dict[str, Any] = {}

    # Per-stage wall-clock timings (ms), surfaced via the translate.perf log
    # line so slow jobs can be diagnosed from the logs alone.
    stages: dict[str, Any] = {"pipeline_path": "lens_direct"}

    img = Image.open(image_path).convert("RGB")
    W, H = img.size
    thai_font, latin_font = resolve_font_pair(target_lang)

    # =========================================================
    # Phase 1 — Lens fetch || ONNX detection (both need only the
    # image; neither depends on the other's result).
    #
    # Typical savings: ONNX ~1.3 s overlaps with Lens ~2 s → the
    # two finish together at ~2 s instead of sequentially at ~3.3 s.
    # Both Lens (httpx I/O) and ONNX (onnxruntime C-ext) release the
    # GIL, so the threads run truly in parallel on CPython.
    # =========================================================
    # Do NOT run ONNX before Lens in AUTO mode.  We first inspect Lens geometry
    # and only then decide whether lens_text.ai really needs self-built blocks.
    # This prevents horizontal->horizontal AI jobs from paying the ONNX cost.
    _need_onnx = False
    _tb_timings: dict = {}
    if isinstance(lens_data, dict):
        # Lens result pre-supplied (CLI replay) — run ONNX alone if needed.
        data: dict = lens_data
        if _need_onnx:
            _t = time.perf_counter()
            text_blocks = detect_text_blocks(img, timings=_tb_timings)
            stages["lens_ms"] = 0.0
            stages["blocks_ms"] = round((time.perf_counter() - _t) * 1000, 1)
        else:
            text_blocks = []
            stages["lens_ms"] = 0.0
            stages["blocks_ms"] = 0.0
    else:
        _t_p1 = time.perf_counter()
        if _need_onnx:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as _p1:
                _f_lens = _p1.submit(
                    lens_client.fetch_lens_data, image_path, target_lang, settings.firebase_url
                )
                _f_onnx = _p1.submit(detect_text_blocks, img, _tb_timings)
                # .result() re-raises exceptions from the worker thread.
                # Wait for Lens first (usually the slower leg).
                _raw = _f_lens.result()
                _t_lens_done = time.perf_counter()
                text_blocks = _f_onnx.result()
                _t_onnx_done = time.perf_counter()
            # Report wall-clock from phase start so log shows true parallel time.
            stages["lens_ms"] = round((_t_lens_done - _t_p1) * 1000, 1)
            stages["blocks_ms"] = round((_t_onnx_done - _t_p1) * 1000, 1)
        else:
            # lens_images: only Lens, no ONNX needed.
            _raw = lens_client.fetch_lens_data(image_path, target_lang, settings.firebase_url)
            stages["lens_ms"] = round((time.perf_counter() - _t_p1) * 1000, 1)
            stages["blocks_ms"] = 0.0
            text_blocks = []
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

    if wants_ai:
        needs_self_blocks, ai_layout_meta = _should_use_onnx_for_ai(
            original_tree, translated_tree, target_lang
        )
        stages.update(ai_layout_meta)
        stages["pipeline_path"] = "self_blocks_ai" if needs_self_blocks else "lens_ai_fast"
        out["pipelinePath"] = stages["pipeline_path"]
        if needs_self_blocks:
            _t = time.perf_counter()
            text_blocks = detect_text_blocks(img, timings=_tb_timings)
            stages["blocks_ms"] = round((time.perf_counter() - _t) * 1000, 1)
            stages["blocks"] = len(text_blocks)
            stages["blocks_lock_ms"] = float(_tb_timings.get("lock_ms", 0.0))
            stages["blocks_infer_ms"] = float(_tb_timings.get("infer_ms", 0.0))
        else:
            text_blocks = []
            stages["blocks_ms"] = 0.0
            stages["blocks"] = 0
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
            if settings.lens_direct_erase and original_span_tokens:
                base_img = erase_text_with_boxes(img, original_span_tokens)
            stages["erase_ms"] = round((time.perf_counter() - _t) * 1000, 1)
            stages["bubble_ms"] = 0.0

            # Cheap text-light annotation only; it uses Lens boxes and the
            # current background image, not any locally detected blocks.
            _annotate_text_light(original_tree, base_img)
            _annotate_text_light(translated_tree, base_img)
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
        if _run_ai:
            _ai_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            _f_ai = _ai_executor.submit(
                _run_ai_layer,
                out, original_tree, translated_tree, ai_cfg, target_lang, W, H, thai_font, latin_font,
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

            if settings.lens_direct_png:
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

        # Per-paragraph background luminance → text colour flag, sampled on
        # the erased image (original glyphs removed). Cheap: ≤24x24 median.
        _annotate_text_light(original_tree, base_img)
        _annotate_text_light(translated_tree, base_img)
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
    _run_ai = bool(ai_cfg and ((ai_cfg.api_key or "").strip() or _ai_is_local))

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

        fit_tree_font_sizes(translated_tree, thai_font, latin_font, W, H)
        out["translated"]["translatedhtml"] = render_tree_overlay(translated_tree, W, H)

        out["htmlCss"] = overlay_css()
        out["htmlMeta"] = {"baseW": int(W), "baseH": int(H), "format": "tp"}
        stages["render_ms"] = round((time.perf_counter() - _t) * 1000, 1)

        # --- Image data URI (already erased above) -------------------------
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
    api_key = str(ai.get("api_key") or "").strip() or settings.ai_api_key
    return AiConfig(
        api_key=api_key,
        model=str(ai.get("model") or "auto").strip() or "auto",
        provider=str(ai.get("provider") or "auto").strip() or "auto",
        base_url=str(ai.get("base_url") or "auto").strip() or "auto",
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

    img_bytes, mime = _extract_image_bytes(payload)
    t_img = time.perf_counter()
    if not img_bytes:
        raise ValueError("No image data")

    ai_cfg = _build_ai_config(payload, mode, source)

    # --- cache lookup ------------------------------------------------------
    img_hash = sha256_hex(img_bytes)
    cache_key = ""
    cache_used = False
    if mode in ("lens_images", "lens_text") and img_hash:
        # Cache direct Lens results too. This avoids repeating the Lens round-trip
        # after extension retries/reconnects. AI still gets its separate cache
        # because prompt/model/provider affect the result.
        cache_source = "ai" if source == "ai" else source or "translated"
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
        out = process_image(tmp_path, lang, mode, ai_cfg, source=source)
        stages = out.pop("perfStages", {}) or {}
        out["perf"] = {
            "cache": "miss" if cache_used else "off",
            "total_ms": round((time.perf_counter() - t_start) * 1000, 1),
            "img_ms": round((t_img - t_start) * 1000, 1),
            "tmp_ms": round((t_tmp - t_img) * 1000, 1),
            **stages,
        }
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
