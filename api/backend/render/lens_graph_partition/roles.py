"""Conservative content roles; uncertain content remains visible and explicit."""
from __future__ import annotations

from dataclasses import replace
from statistics import median

from .model import RubyAttachment, VerticalNode

_PUNCT = set("。､、･・…！!？?ー―〜~（）()「」『』　 \t\r\n")


def _kana_only(text: str) -> bool:
    core = [char for char in text if char not in _PUNCT]
    return bool(core) and len(core) <= 8 and all(
        0x3040 <= ord(char) <= 0x30FF for char in core
    )


def _kanji(text: str) -> bool:
    return any(0x3400 <= ord(char) <= 0x9FFF for char in text)


def preclassify_ruby(nodes: tuple[VerticalNode, ...]):
    """Peel off only short right-side annotations before forming envelopes.

    A tiny paragraph cannot supply a column head or a separator corridor. A
    tied, left-side, long or weakly overlapping candidate remains dialogue.
    """
    attachments = []
    for node in nodes:
        if not _kana_only(node.text):
            continue
        x1, y1, x2, y2 = node.bounds
        bases = []
        for base in nodes:
            if base is node or not _kanji(base.text):
                continue
            if (node.container_id is not None and base.container_id is not None
                    and node.container_id != base.container_id):
                continue
            bx1, by1, bx2, by2 = base.bounds
            overlap = max(0., min(y2, by2) - max(y1, by1))
            glyph = node.glyph_px
            if (base.glyph_px >= 1.75 * glyph and
                    y2 - y1 <= .70 * (by2 - by1) and
                    overlap >= .80 * (y2 - y1) and
                    bx2 - .5 * glyph <= x1 <= bx2 + .5 * glyph):
                bases.append(base)
        if len(bases) == 1:
            attachments.append(RubyAttachment(
                node.paragraph_id, bases[0].paragraph_id, "short_right_ruby_proof"))
    ruby_ids = {item.ruby_id for item in attachments}
    return tuple(node for node in nodes if node.paragraph_id not in ruby_ids), tuple(attachments)


def classify_candidate(
    nodes: tuple[VerticalNode, ...],
    retained_ids: frozenset[str] = frozenset(),
) -> tuple[tuple[VerticalNode, ...], tuple[RubyAttachment, ...], tuple[str, ...]]:
    """Classify one container and attach ruby only to a unique local base."""
    roles = []
    attachments = []
    ordinary_scale = median([node.glyph_px for node in nodes]) if nodes else 1.0
    for node in nodes:
        if not node.text.strip() or all(char in _PUNCT for char in node.text):
            roles.append(replace(node, role="punctuation"))
            continue
        candidate = None
        if _kana_only(node.text):
            x1, y1, x2, y2 = node.bounds
            candidates = []
            for base in nodes:
                if base is node or not _kanji(base.text):
                    continue
                bx1, by1, bx2, by2 = base.bounds
                overlap = max(0.0, min(y2, by2) - max(y1, by1))
                ratio = overlap / max(1.0, y2 - y1)
                gap = max(bx1 - x2, x1 - bx2, 0.0)
                if base.glyph_px >= 1.6 * node.glyph_px and ratio >= .4 \
                        and gap <= 1.6 * node.glyph_px:
                    gap_units = gap / node.glyph_px
                    # Vertical Japanese ruby is normally on the right of its
                    # base column. Direction is topology evidence, not a text
                    # label or paragraph-order shortcut.
                    right_side_penalty = 0.0 if bx1 >= x2 else .35
                    candidates.append((gap_units + right_side_penalty,
                                       gap_units, -ratio,
                                       base.paragraph_id, base))
            candidates.sort(key=lambda item: item[:3])
            # Close proximity is positive evidence.  A merely nearest base in
            # a wide inter-column gap is not proof and must remain unresolved.
            if candidates and candidates[0][1] <= .5:
                runner_margin = (candidates[1][0] - candidates[0][0]
                                 if len(candidates) >= 2 else float("inf"))
                if runner_margin >= .25:
                    candidate = candidates[0][4]
            # If positive proof is absent or tied, retain the source as
            # dialogue.  Guessing that ordinary kana dialogue is ruby loses
            # translatable content; retaining it preserves the OCR contract.
        if candidate and node.paragraph_id not in retained_ids:
            attachments.append(RubyAttachment(
                node.paragraph_id, candidate.paragraph_id,
                "kana_scale_overlap_proof",
            ))
        else:
            # Only strong page-relative display evidence earns SFX isolation;
            # lexical guessing alone would misclassify short dialogue.
            visible = [char for char in node.text if char not in _PUNCT]
            # Size and brevity alone never make SFX.  Katakana-only sound text
            # plus independent display scale is the narrow explicit case.
            katakana = bool(visible) and all(0x30A0 <= ord(c) <= 0x30FF
                                             for c in visible)
            role = ("sfx" if katakana and len(visible) <= 4 and
                    node.glyph_px >= 1.8 * max(ordinary_scale, 1.0)
                    else "dialogue")
            roles.append(replace(node, role=role))
    unresolved = tuple(node.paragraph_id for node in roles
                       if node.role == "unknown")
    return tuple(roles), tuple(attachments), unresolved


def classify_and_attach_ruby(nodes: tuple[VerticalNode, ...]):
    """Compatibility wrapper for the original two-value internal API."""
    classified, attachments, _unresolved = classify_candidate(nodes)
    return classified, attachments
