"""Pour an AI translation into a template tree.

``patch`` takes the marker-encoded AI text plus a *template tree* (normally
the Lens **Translated** tree, because it already carries target-language
geometry: the right number of lines per bubble, each line's free-angle
baseline, the polyline that approximates a curved bubble).

Each paragraph of AI text is distributed across the template paragraph's
items by :func:`backend.render.layout.distribute_to_template` — which
mirrors how Lens itself split the same paragraph (one line per item).  The
result is an ``Ai`` tree with the same geometry as the template but the AI's
(better) wording.

Per-item *font sizes* are picked by
:func:`backend.render.tp_html.fit_item_font_size`, a closed-form formula
that doesn't need Pillow.  The renderer (`render_tree_overlay`) emits one
``<div class="tp-line">`` per item with that font size — no per-word span
tiling, no PIL fonts, no fragile measurement.
"""

from __future__ import annotations

import copy
from typing import Any

from backend.ai import markers
from backend.lens.languages import normalize as normalize_lang
from backend.render.fonts import budoux_parser
from backend.render.layout import (
    distribute_to_template,
    font_size_minimum_for_image,
    pad_lines,
)
from backend.render.tp_html import fit_item_font_size
from backend.utils.text import ZWSP


def _patch_groups(
    ai_text_full: str,
    out_tree: dict,
    paragraphs: list[dict],
    lang_norm: str,
    parser: Any,
    min_size_px: int,
    img_w: int,
    img_h: int,
    group_map: list[list[int]],
) -> dict[str, Any]:
    """Group-level variant of :func:`patch`.

    ``ai_text_full`` carries one ``<<TP_Pn>>`` marker per *bubble group* (not
    per Lens paragraph).  Each group's translated text is distributed across
    the combined items of ALL paragraphs in that group via
    :func:`distribute_to_template`, then the item texts are written back to
    their individual paragraphs so that the downstream
    :func:`group_paragraphs_into_bubbles` re-groups them correctly.

    ``group_map[i]`` is the sorted list of ``para_index`` values that belong
    to group ``i``.
    """
    n_groups = len(group_map)
    extracted = markers.extract_paragraphs(ai_text_full, n_groups)
    if extracted is not None:
        ai_group_texts, ai_text_full_clean = extracted
    else:
        ai_group_texts = (ai_text_full or "").split("\n\n")
        if len(ai_group_texts) < n_groups:
            ai_group_texts += [""] * (n_groups - len(ai_group_texts))
        ai_text_full_clean = "\n\n".join(ai_group_texts[:n_groups])

    # Build para_index → para dict once.
    para_by_idx: dict[int, Any] = {}
    for p in paragraphs:
        pi = int(p.get("para_index", 0))
        para_by_idx[pi] = p

    # Separator for joining item texts within a paragraph: scriptio-continua
    # languages (Thai / CJK) don't use inter-word spaces.
    sep_char = "" if parser is not None else " "

    raw_cursor = 0
    for gi, para_indices in enumerate(group_map):
        group_ai_text = ai_group_texts[gi] if gi < len(ai_group_texts) else ""

        # Collect all items from every paragraph in this group, in para order.
        all_items: list[Any] = []
        para_item_ranges: list[tuple[int, int, int]] = []  # (pi, start, end)
        for pi in para_indices:
            para = para_by_idx.get(pi)
            if para is None:
                continue
            items = para.get("items") or []
            start = len(all_items)
            all_items.extend(items)
            end = len(all_items)
            if items:
                para_item_ranges.append((pi, start, end))

        if not all_items:
            continue

        max_lines = len(all_items)
        lines = distribute_to_template(
            group_ai_text, all_items, parser, lang_norm, img_w, img_h
        )
        lines = pad_lines(lines, max_lines)

        # Assign line texts and font sizes to every item.
        all_sizes: list[int] = []
        for li, item in enumerate(all_items):
            line_tokens = lines[li] if li < len(lines) else []
            line_text = _line_text(line_tokens)

            item["side"] = "Ai"
            item["text"] = line_text
            item["valid_text"] = bool(line_text)
            item["start_raw"] = raw_cursor
            item["end_raw"] = raw_cursor + len(line_text)
            item["spans"] = []

            box = item.get("box") or {}
            width_pct = float(
                box.get("width_pct") or (float(box.get("width") or 0.0) * 100.0)
            )
            height_pct = float(
                box.get("height_pct") or (float(box.get("height") or 0.0) * 100.0)
            )
            fs = fit_item_font_size(
                width_pct, height_pct, line_text or "ก", img_w, img_h
            )
            fs = max(min_size_px, fs)
            item["font_size_px"] = int(fs)
            all_sizes.append(fs)
            raw_cursor = item["end_raw"] + 1

        # Write back item-index, para-index, and para-level summary fields.
        for pi, start, end in para_item_ranges:
            para = para_by_idx.get(pi)
            if para is None:
                continue
            slice_items = all_items[start:end]
            for ii, item in enumerate(slice_items):
                item["para_index"] = pi
                item["item_index"] = ii

            para["side"] = "Ai"
            para["para_index"] = pi
            slice_texts = [str(it.get("text") or "") for it in slice_items]
            para["text"] = sep_char.join(t for t in slice_texts if t).strip()
            para["valid_text"] = bool(para["text"])
            if all_sizes[start:end]:
                sz_slice = sorted(all_sizes[start:end])
                para["para_font_size_px"] = sz_slice[len(sz_slice) // 2]
            # Approximate raw offsets (informational only).
            if start < len(all_items):
                para["start_raw"] = all_items[start].get("start_raw", raw_cursor)
            if end - 1 < len(all_items):
                para["end_raw"] = all_items[end - 1].get("end_raw", raw_cursor)

        raw_cursor += 2  # paragraph separator

    return {"aiTextFull": ai_text_full_clean, "aiTree": out_tree}


def _line_text(tokens: list[tuple[str, str, float]]) -> str:
    """Reassemble a distributed line's token list back into a flat string.

    ``distribute_to_template`` returns one line per template item as a list
    of ``(kind, text, _)`` tuples (kind = ``"word"`` or ``"space"``).  For
    item-level rendering we just concatenate them, drop the zero-width
    sentinel and trim outer whitespace.
    """
    return "".join(
        s for _kind, s, _w in (tokens or []) if s and s != ZWSP
    ).strip()


def patch(
    ai_text_full: str,
    template_tree: dict,
    img_w: int,
    img_h: int,
    _thai_font: str,
    _latin_font: str,
    lang: str,
    group_map: list[list[int]] | None = None,
) -> dict[str, Any]:
    """Build the ``Ai`` tree from ``ai_text_full`` + ``template_tree``.

    Returns ``{"aiTextFull": <clean text>, "aiTree": <tree>}``.  Mutates a
    deep copy of the template — original/translated trees aren't touched.
    """
    if not isinstance(template_tree, dict):
        raise ValueError("template_tree must be a dict")

    lang_norm = normalize_lang(lang)
    parser = budoux_parser(lang_norm)

    out_tree = copy.deepcopy(template_tree)
    out_tree["side"] = "Ai"
    paragraphs = out_tree.get("paragraphs") or []

    # Readability floor scales with image resolution
    # (font_size_minimum = (W + H) / 200, à la manga-image-translator).
    min_size_px = font_size_minimum_for_image(img_w, img_h)

    # When a group_map is provided the AI text has one marker per bubble group,
    # not one per paragraph.  Delegate to the group-aware distributor.
    if group_map is not None:
        return _patch_groups(
            ai_text_full, out_tree, paragraphs,
            lang_norm, parser, min_size_px,
            img_w, img_h, group_map,
        )

    # Split the AI text into one string per paragraph, marker-aware.
    extracted = markers.extract_paragraphs(ai_text_full, len(paragraphs))
    if extracted is not None:
        ai_paras, ai_text_full_clean = extracted
    else:
        ai_paras = ai_text_full.split("\n\n") if ai_text_full else []
        if len(ai_paras) < len(paragraphs):
            ai_paras += [""] * (len(paragraphs) - len(ai_paras))
        elif len(ai_paras) > len(paragraphs):
            ai_paras = ai_paras[: len(paragraphs)]
        ai_text_full_clean = "\n\n".join(ai_paras)

    raw_cursor = 0
    for pi, (para, ptext) in enumerate(zip(paragraphs, ai_paras)):
        para["side"] = "Ai"
        para["para_index"] = int(para.get("para_index", pi))
        items = para.get("items") or []
        max_lines = len(items)
        if max_lines <= 0:
            continue

        # Distribute the AI paragraph across the template's items, mirroring
        # how Lens split the same paragraph (one line per template item).
        lines = distribute_to_template(ptext, items, parser, lang_norm, img_w, img_h)
        lines = pad_lines(lines, max_lines)

        para["text"] = ptext
        para["valid_text"] = bool(ptext)
        para["start_raw"] = raw_cursor
        para["end_raw"] = raw_cursor + len(ptext)

        # Walk each template item, install its slice of the AI text, and
        # pick a font size with the closed-form heuristic.  No spans, no PIL.
        para_sizes: list[int] = []
        line_start = raw_cursor
        for ii in range(max_lines):
            item = items[ii]
            item["side"] = "Ai"
            item["para_index"] = pi
            item["item_index"] = ii

            line_tokens = lines[ii] if ii < len(lines) else []
            line_text = _line_text(line_tokens)

            item["text"] = line_text
            item["valid_text"] = bool(line_text)
            item["start_raw"] = line_start
            item["end_raw"] = line_start + len(line_text)

            # Per-item geometry → per-item font size.
            box = item.get("box") or {}
            width_pct = float(box.get("width_pct") or (float(box.get("width") or 0.0) * 100.0))
            height_pct = float(box.get("height_pct") or (float(box.get("height") or 0.0) * 100.0))
            fs = fit_item_font_size(width_pct, height_pct, line_text or "ก", img_w, img_h)
            fs = max(min_size_px, fs)
            item["font_size_px"] = int(fs)
            # We no longer maintain per-word spans for the AI layer — the
            # renderer reads ``item.text`` directly.  Keep the field as an
            # empty list so any consumer that iterates it stays happy.
            item["spans"] = []
            para_sizes.append(int(fs))

            line_start = item["end_raw"]

        # Paragraph gets a shared "reference" size (median) so callers that
        # need one value per paragraph have it.  The renderer still picks
        # per-item sizes — this is just informational.
        if para_sizes:
            para["para_font_size_px"] = sorted(para_sizes)[len(para_sizes) // 2]

        raw_cursor = para["end_raw"] + 2  # +2 for the "\n\n" between paragraphs

    return {"aiTextFull": ai_text_full_clean, "aiTree": out_tree}
