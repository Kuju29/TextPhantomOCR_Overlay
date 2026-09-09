"""AI tree construction, translation and overlay rendering."""

from __future__ import annotations

from typing import Any
from PIL import Image

from backend.ai import markers, wire_trace
from backend.ai.translation.contracts import AiConfig
from backend.jobs.stages import ai_conservation, ai_repair, render_stage
from backend.grouping.ai_source_tree import AiSourceTreeError, require_ai_source_tree
from backend.lens.tree import paragraph_texts, tree_stats
from backend.log import dbg, event
from backend.render.ai_tree.builder import build_ai_tree
from backend.render.patch import patch as patch_ai_tree
from backend.render.html.overlay import render_tree_overlay

from backend.jobs.stage_admission import stage_slot


def _canonical_group_units(
    ai_source_tree: dict | None,
    src_paras_raw: list[str],
) -> tuple[list[dict[str, Any]], list[list[int]], list[str]]:
    """Read translation units only from the canonical original-tree contract.

    Grouping is an upstream decision.  This stage must neither reconstruct it
    nor add uncovered paragraphs as implicit singleton groups: either action
    can hide a broken OCR-to-group handoff and send different content to AI.
    """
    try:
        source_tree = require_ai_source_tree(ai_source_tree)
    except AiSourceTreeError as exc:
        raise ai_conservation.AiInputConservationError(exc.code) from exc
    raw_groups = source_tree.get("paragraphs")
    has_source = any(str(text or "").strip() for text in src_paras_raw)
    if not isinstance(raw_groups, list) or (has_source and not raw_groups):
        raise ai_conservation.AiInputConservationError(
            "canonical_ai_source_tree_missing: detector-free grouping must "
            "complete before AI dispatch"
        )

    groups: list[dict[str, Any]] = []
    unit_indices: list[list[int]] = []
    unit_texts: list[str] = []
    for group_index, group in enumerate(raw_groups):
        if not isinstance(group, dict):
            raise ai_conservation.AiInputConservationError(
                f"canonical_original_paragraph_invalid: paragraph {group_index} is not an object"
            )
        if group.get("ai_eligible") is False:
            continue
        contract = group.get("source")
        if not isinstance(contract, dict) or contract.get("contract") != "tp.ai-source-members/1":
            raise ai_conservation.AiInputConservationError(
                f"canonical_source_contract_invalid: group {group_index} "
                "does not carry tp.ai-source-members/1"
            )
        indices = contract.get("rawParagraphIndices")
        if not isinstance(indices, list) or not indices:
            raise ai_conservation.AiInputConservationError(
                f"canonical_source_contract_invalid: group {group_index} has no members"
            )
        checked_indices: list[int] = []
        for raw_index in indices:
            if (not isinstance(raw_index, int) or isinstance(raw_index, bool)
                    or raw_index < 0):
                raise ai_conservation.AiInputConservationError(
                    f"canonical_source_contract_invalid: group {group_index} "
                    "has an invalid rawParagraphIndex"
                )
            checked_indices.append(raw_index)
        # The legacy renderer builder still consumes ``para_indices`` and
        # ``bubble_bounds_px``.  They are an internal adapter made only from
        # the canonical parent; no old grouping result is consulted.
        groups.append({
            **group,
            "para_indices": checked_indices,
            "bubble_bounds_px": group.get("bounds_px"),
            "source_contract": {
                "version": "tp.group-source/2",
                "members": [
                    {"rawParagraphIndex": value}
                    for value in checked_indices
                ],
            },
        })
        unit_indices.append(checked_indices)
        unit_texts.append(str(group.get("text") or "").strip())
    return groups, unit_indices, unit_texts

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

def run_ai_layer(
    out: dict[str, Any],
    original_tree: dict | None,
    translated_tree: dict | None,
    ai_cfg: AiConfig,
    target_lang: str,
    W: int,
    H: int,
    thai_font: str,
    latin_font: str,
    ai_source_tree: dict | None = None,
    *,
    base_img: Image.Image | None = None,
    vision_img: Image.Image | None = None,
    capture_request: bool = False,
    use_lens_template: bool = False,
    layout_meta: dict[str, Any] | None = None,
    cancel_check=None,
    admission_identity: str = "anon",
    admission_unlimited: bool = False,
) -> dict | None:
    """Translate with AI, patch into a tree, and write the ``Ai`` result.

    Returns the AI tree (or ``None`` when there is nothing to translate).
    Mutates ``out`` (sets ``AiTextFull`` / ``Ai``) and the passed-in trees
    (font sizes are shared across all three layers).
    """
    src_paras_raw = paragraph_texts(original_tree or {})

    # Build one translation unit per canonical parent so short fragments (e.g. "そ"
    # at the top of a vertical bubble) are translated in context together with
    # their neighbours ("そんなことないよ!") rather than in isolation.
    # The canonical parent owns the joined text, ordered source membership and
    # untouched child geometry. No AI consumer reads the legacy group sidecar.
    canonical_parents, group_para_indices, merged_src_paras = (
        _canonical_group_units(ai_source_tree, src_paras_raw)
    )

    event("ai.input_conservation", {
        "schema": "tp.canonical-original-tree/1",
        "complete": True,
        "rawParagraphs": len(src_paras_raw),
        "units": len(merged_src_paras),
    })

    # Units Lens read as digits, punctuation or symbols only are never sent: they
    # cost tokens, come back unchanged, and their source text is the right answer.
    # Same rule as `hasTranslatableText` in src/shared/lens-document.js.
    all_group_para_indices = group_para_indices
    all_group_src_paras = merged_src_paras
    translation_group_para_indices: list[list[int]] = []
    kept_paras: list[str] = []
    for idxs, text in zip(all_group_para_indices, all_group_src_paras):
        if markers.has_translatable_text(text):
            translation_group_para_indices.append(idxs)
            kept_paras.append(text)
    if not kept_paras:
        out["AiTextFull"] = ""
        out["Ai"] = {"meta": {"skipped": True, "skipped_reason": "no_translatable_text"}}
        return None
    passthrough_count = len(all_group_src_paras) - len(kept_paras)
    # Only linguistic units go to the model. The full ordered group list stays
    # untouched and is reassembled after translation for renderer attachment.
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
                ai_cfg.image_b64, ai_cfg.image_mime = render_stage.encode_vision_image(vimg)
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
    if want_image and str(getattr(ai_cfg, "thinking", "off")).lower() != "off":
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
        for _gi, _idxs in enumerate(translation_group_para_indices):
            for _ri in _idxs:
                _name = str(_raw_speakers.get(str(_ri)) or "").strip()
                if _name:
                    _remapped[str(_gi)] = _name
                    break
        ai_cfg.speakers = _remapped

    # Defensive production boundary: callers and old serialized profiles must
    # not re-enable a second provider generation.  Attributable empty units are
    # retained as an explicit partial result below.
    ai_cfg.repair_enabled = False
    with stage_slot("ai", admission_identity, unlimited=admission_unlimited):
        result = ai_repair.translate_with_one_repair(
            src_text, target_lang, ai_cfg, n_src,
            capture_request=capture_request,
            cancel_check=cancel_check,
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
    meta["layout_path"] = (
        "lens_template_fast" if use_lens_template else "lens_graph_partition"
    )

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
    translated_group_texts, ai_text_full_clean = extracted

    # A unit the model returned empty stays empty and is named. Same rule as the
    # extension path: draw what came back, report the rest, never invent filler.
    missing_units = [i for i, t in enumerate(translated_group_texts) if not str(t or "").strip()]
    if missing_units and len(missing_units) >= n_src:
        raise RuntimeError("AI returned no usable text for any unit")
    # Reinsert numeric/symbol-only groups at their ORIGINAL spatial positions.
    # This produces a one-to-one renderer text/group map without ever asking AI
    # to translate content whose correct answer is the source itself.
    ai_group_texts: list[str] = []
    translated_cursor = 0
    for source in all_group_src_paras:
        if markers.has_translatable_text(source):
            ai_group_texts.append(translated_group_texts[translated_cursor])
            translated_cursor += 1
        else:
            ai_group_texts.append(source)
    render_ai_text_full = markers.apply(ai_group_texts)
    meta["missing_units"] = missing_units
    meta["passthrough_units"] = passthrough_count
    meta["units"] = n_src
    # Named so a log can tell "the server grouped the page" from "the server
    # gave up on grouping and translated the fragments anyway".
    meta["grouping"] = "ai_source_tree"
    # Which SOURCE paragraphs those units came from. The erase already ran, so
    # the caller needs this to put the original pixels back before the reply is
    # encoded — an unanswered bubble must show its own text, never a blank.
    missing_paras: set[int] = set()
    for unit in missing_units:
        if 0 <= unit < len(translation_group_para_indices):
            missing_paras.update(int(i) for i in translation_group_para_indices[unit])
    meta["missing_paragraph_indices"] = sorted(missing_paras)
    if missing_units:
        dbg("ai.partial", {"expected": n_src, "missing": len(missing_units),
                           "missing_units": missing_units,
                           "missing_paragraph_indices": sorted(missing_paras)})

    if use_lens_template:
        # Fast same-orientation AI path: pour the AI wording into Lens's own
        # geometry instead of rebuilding boxes from Lens graph groups.
        # This is the right path for horizontal->horizontal and vertical->vertical
        # text because Lens already returned suitable paragraph/item boxes.
        template_tree = _pick_template_tree(original_tree, translated_tree)
        # If group_para_indices is just a one-to-one paragraph map, patching
        # without a group_map is cheaper and preserves Lens paragraphs exactly.
        one_to_one = (
            len(all_group_para_indices) == len((template_tree or {}).get("paragraphs") or [])
            and all(len(xs) == 1 and xs[0] == i for i, xs in enumerate(all_group_para_indices))
        )
        patched = patch_ai_tree(
            render_ai_text_full,
            template_tree,
            W, H,
            target_lang,
            group_map=None if one_to_one else all_group_para_indices,
        )
        ai_tree = patched.get("aiTree") or {}
        ai_text_full_clean = str(patched.get("aiTextFull") or ai_text_full_clean)
    else:
        # Quality / direction-change AI path: build a fresh AI tree from the
        # canonical Lens graph groups plus target-language direction. This is
        # reserved for cases like vertical Japanese -> horizontal Thai where
        # the original Lens boxes are too narrow for the new reading direction.
        ai_tree = build_ai_tree(
            canonical_parents,
            ai_group_texts,
            original_tree or {},
            target_lang,
            W, H,
        )

    out["AiTextFull"] = ai_text_full_clean
    out["Ai"] = {"aiTextFull": ai_text_full_clean, "aiTree": ai_tree, "meta": meta}

    # Glossary pairs (source -> translated) for this image, so the client can
    # accumulate a translation memory across a multi-image batch and feed it
    # back via ``ai.glossary`` on later requests (terminology consistency).
    # Pairs short, term-like units only (<= 24 source chars) — full sentences
    # are too specific to reuse and would bloat the next prompt.
    glossary_pairs: list[dict] = []
    for gi2, (idxs, src) in enumerate(zip(translation_group_para_indices, merged_src_paras)):
        tgt = translated_group_texts[gi2] if gi2 < len(translated_group_texts) else ""
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
    render_stage.annotate_text_light(ai_tree, base_img)

    # AI HTML overlay — ``target_lang`` drives the deterministic reading
    # direction (see backend.render.region.resolve_text_direction).
    out["Ai"]["aihtml"] = render_tree_overlay(ai_tree, W, H, target_lang=target_lang)
    out["Ai"]["aihtmlMeta"] = {"baseW": int(W), "baseH": int(H), "format": "tp"}

    wire_trace.write_json("08_apply_result.json", {
        "translations": [
            {"id": f"P{index}", "text": text,
             "sourceParagraphIndices": translation_group_para_indices[index]}
            for index, text in enumerate(translated_group_texts)
        ],
        "missingUnitIndices": missing_units,
        "missingParagraphIndices": sorted(missing_paras),
        "aiTreeParagraphs": len(ai_tree.get("paragraphs") or []),
    })

    dbg("ai.built", {"stats_ai": tree_stats(ai_tree), "lang": target_lang})
    return ai_tree
