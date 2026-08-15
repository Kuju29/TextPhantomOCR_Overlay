"""Canonical LensDocument — the boundary between Lens and everything else.

Why this exists
---------------
``lens/tree.py`` produces a structure shaped by Google's protobuf: fields named
``start_raw``, ``t0_raw``, ``rotation_deg_css``, spans nested inside items
nested inside paragraphs, coordinates in three different conventions. Every
consumer — the renderer, the AI patcher, the erase step — reads that shape
directly, which means every one of them breaks the day Lens changes it.

``tp.lens-document/1`` is deliberately small and boring: paragraphs, their
text, and the geometry needed to draw them. When Lens changes, this module
changes and nothing else does.

It is also the wire format. The extension needs the same structure to render
locally and to send text to an AI provider itself, and a schema that both sides
implement from a written spec drifts. One document, one version string.

Coordinates
-----------
Everything is normalised to 0..1 against the image, so a document survives the
image being resized — which it will be, because the browser displays it at CSS
size while Lens measured it at natural size.
"""

from __future__ import annotations

from typing import Any

SCHEMA = "tp.lens-document/1"

# 5 decimals ≈ 0.01 px on a 1000 px page: below what any renderer can act on,
# and roughly a third of the payload of full float repr.
_PRECISION = 5


def _round(value: Any) -> float | None:
    """Round to the wire precision, or ``None`` when there is no number here.

    This used to substitute ``0.0``. Zero is a real coordinate — the top-left
    corner of the page — so a missing ``x`` became an item pinned to the corner
    and the page read as a layout bug. Returning ``None`` lets the caller drop
    the item and COUNT it, which is what the ``warnings`` list is for.
    """
    try:
        rounded = round(float(value), _PRECISION)
    except (TypeError, ValueError):
        return None
    if rounded != rounded or rounded in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return rounded


def _point(raw: Any) -> list[float] | None:
    if not isinstance(raw, dict):
        return None
    if "x" not in raw or "y" not in raw:
        return None
    x = _round(raw.get("x"))
    y = _round(raw.get("y"))
    if x is None or y is None:
        return None
    return [x, y]


def _items(para_id: str, raw_items: Any, *, layer: str = "") -> tuple[list[dict[str, Any]], int]:
    """Every usable item of one paragraph, and how many were unusable."""
    out: list[dict[str, Any]] = []
    dropped = 0
    prefix = f"{para_id}{layer}"
    for index, raw_item in enumerate(raw_items or []):
        if not isinstance(raw_item, dict):
            dropped += 1
            continue
        item = _item(prefix, index, raw_item)
        if item is None:
            dropped += 1
            continue
        out.append(item)
    return out, dropped


def _item(para_id: str, index: int, raw: dict) -> dict[str, Any] | None:
    """One baseline segment, or None when its geometry is unusable.

    A paragraph is a polyline: each item carries its own straight baseline, so
    curved text is approximated by several items at slightly different angles.
    Dropping an item silently would shorten a line of text without any error,
    so callers are told how many were dropped (see :func:`build`).
    """
    p1 = _point(raw.get("baseline_p1"))
    p2 = _point(raw.get("baseline_p2"))
    if p1 is None or p2 is None:
        return None

    height = _round(raw.get("height_raw"))
    if height is None or height <= 0:
        return None

    box = raw.get("box") if isinstance(raw.get("box"), dict) else {}
    # Rotation genuinely defaults: an upright box omits it, and "unset" and
    # "0°" are the same intent. A present-but-unreadable rotation is not the
    # same thing, and drops the item.
    if "rotation_deg" not in box:
        rotation: float | None = 0.0
    else:
        rotation = _round(box.get("rotation_deg"))
        if rotation is None:
            return None

    spans: list[dict[str, Any]] = []
    for raw_span in raw.get("spans") or []:
        if not isinstance(raw_span, dict):
            continue
        raw_t0 = _round(raw_span.get("t0_raw"))
        raw_t1 = _round(raw_span.get("t1_raw"))
        if raw_t0 is None or raw_t1 is None:
            continue
        t0 = max(0.0, min(1.0, raw_t0))
        t1 = max(0.0, min(1.0, raw_t1))
        if t1 <= t0:
            continue
        spans.append({"text": str(raw_span.get("text") or ""), "t0": t0, "t1": t1})

    item = {
        "id": f"{para_id}-i{index}",
        "baseline": [p1, p2],
        "height": height,
        "rotation": rotation,
        "text": str(raw.get("text") or ""),
    }
    if spans:
        item["spans"] = spans
    return item


def build(
    original_tree: dict | None,
    translated_tree: dict | None,
    *,
    width: int,
    height: int,
    source_lang: str = "",
    target_lang: str = "",
) -> dict[str, Any]:
    """Build a ``tp.lens-document/1`` from the decoded Lens trees.

    ``translated_tree`` supplies Lens's own machine translation per paragraph.
    It is matched by POSITION, which is what Lens itself guarantees: paragraph
    *n* of the translated tree is paragraph *n* of the original. When the two
    trees disagree in length that assumption has broken, and the mismatch is
    reported rather than papered over — a document whose ``lensText`` is
    silently offset by one would mistranslate the whole page.
    """
    paragraphs: list[dict[str, Any]] = []
    dropped_items = 0

    original_paras = (original_tree or {}).get("paragraphs") or []
    translated_paras = (translated_tree or {}).get("paragraphs") or []

    for index, raw in enumerate(original_paras):
        if not isinstance(raw, dict):
            continue
        para_id = f"p{index}"

        items, dropped = _items(para_id, raw.get("items"))
        dropped_items += dropped

        # The TRANSLATED layer's own lines, not just its concatenated string.
        #
        # Lens breaks its machine translation across the same paragraph into
        # its own items, each with its own baseline and its own text — and this
        # builder used to keep only `text`, throwing that geometry away. The
        # renderer then had nothing to draw a multi-line translation with and
        # refused every page that had one, which on a real chapter is every
        # page: measured 2026-08-07, "1 to 12 paragraph(s) span several lines"
        # on every single image of a 37-page run.
        #
        # A translation does not break where the source did, so the original
        # layer's items cannot stand in for it. These are the translated
        # layer's OWN items, so the layer is now exact rather than approximated.
        lens_text = ""
        lens_items: list[dict[str, Any]] = []
        if index < len(translated_paras) and isinstance(translated_paras[index], dict):
            translated_raw = translated_paras[index]
            lens_text = str(translated_raw.get("text") or "")
            lens_items, dropped = _items(para_id, translated_raw.get("items"), layer="t")
            dropped_items += dropped

        paragraphs.append(
            {
                "id": para_id,
                "sourceText": str(raw.get("text") or ""),
                "lensText": lens_text,
                "items": items,
                "lensItems": lens_items,
                # Does this paragraph sit on a DARK background?
                #
                # The server samples the erased image and flips its own markup
                # to white-text-on-dark-halo via `.tp-on-dark`. The client has
                # the identical CSS class — and had no way to know when to use
                # it, because this flag was not in the document. The moment the
                # client renderer started actually running (2026-08-07) every
                # dark page came out as near-black text on black: legible in
                # the server's markup, unreadable in ours, from the same data.
                #
                # Set by `_annotate_text_light` BEFORE this builder runs.
                "textLight": bool(raw.get("text_light")),
            }
        )

    document: dict[str, Any] = {
        "schema": SCHEMA,
        "image": {"width": int(width), "height": int(height)},
        "languages": {"source": source_lang or "", "target": target_lang or ""},
        "paragraphs": paragraphs,
    }

    warnings: list[str] = []
    if dropped_items:
        warnings.append(f"dropped {dropped_items} item(s) with unusable geometry")
    if translated_paras and len(translated_paras) != len(original_paras):
        warnings.append(
            f"paragraph count mismatch: original={len(original_paras)} "
            f"translated={len(translated_paras)} — lensText may be misaligned"
        )
    if warnings:
        document["warnings"] = warnings

    return document


def attach_ai_layer(document: dict | None, ai_tree: dict | None) -> int:
    """Give each paragraph the AI layer's own lines. Returns how many got them.

    Mutates ``document`` in place, because it is called after the AI thread
    joins and the document is already sitting in the reply.

    Why this is a separate call
    ---------------------------
    The AI text does not exist when :func:`build` runs — the provider call is
    still in flight, deliberately, so it overlaps with rendering. But the AI
    layer has the same problem the translated layer had: one string per unit,
    laid out across several lines, and a renderer cannot guess where the breaks
    go. ``build_ai_tree`` already solved that server-side and produced real
    per-line geometry; this hands the same geometry to the client so it can
    draw the AI layer itself instead of asking for the server's markup.

    Matching is BY POSITION, the same contract ``build`` uses for the
    translated tree, and a length mismatch is recorded as a warning rather than
    quietly truncating: an AI layer offset by one paragraph would put every
    speech bubble's text in the wrong bubble and still look like a translation.
    """
    if not isinstance(document, dict):
        return 0
    paragraphs = document.get("paragraphs")
    if not isinstance(paragraphs, list) or not paragraphs:
        return 0

    ai_paras = (ai_tree or {}).get("paragraphs") or []
    if not ai_paras:
        return 0

    attached = 0
    dropped = 0
    for index, para in enumerate(paragraphs):
        if not isinstance(para, dict) or index >= len(ai_paras):
            continue
        raw = ai_paras[index]
        if not isinstance(raw, dict):
            continue
        items, lost = _items(str(para.get("id") or f"p{index}"), raw.get("items"), layer="a")
        dropped += lost
        if not items:
            continue
        para["aiItems"] = items
        # The AI layer is re-laid out, so it can land on a different patch of
        # background than the source paragraph did. `_run_ai_layer` samples the
        # AI tree separately for exactly that reason; carry ITS answer rather
        # than reusing the source layer's.
        if "text_light" in raw:
            para["aiTextLight"] = bool(raw.get("text_light"))
        attached += 1

    warnings = document.setdefault("warnings", [])
    if len(ai_paras) != len(paragraphs):
        warnings.append(
            f"paragraph count mismatch: document={len(paragraphs)} "
            f"ai={len(ai_paras)} — aiItems may be misaligned"
        )
    if dropped:
        warnings.append(f"dropped {dropped} AI item(s) with unusable geometry")
    if not warnings:
        document.pop("warnings", None)
    return attached


def translation_units(document: dict | None) -> list[dict[str, Any]]:
    """The text worth sending to a translator, as addressable units.

    Paragraphs with no source text are skipped: they cost tokens, come back
    empty, and then look like a translation failure. Each unit keeps the ids of
    the paragraphs it came from so the answer can be patched back exactly.
    """
    units: list[dict[str, Any]] = []
    for para in (document or {}).get("paragraphs") or []:
        if not isinstance(para, dict):
            continue
        text = str(para.get("sourceText") or "").strip()
        if not text:
            continue
        units.append(
            {
                "id": f"g{len(units)}",
                "text": text,
                "paragraphIds": [str(para.get("id") or "")],
            }
        )
    return units
