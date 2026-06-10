"""Paragraph-marker protocol used to keep AI translations aligned with the
original paragraph order.

The OCR step gives us N original paragraphs.  We feed them to the LLM as

    <<TP_P0>>
    paragraph zero
    <<TP_P1>>
    paragraph one
    ...

and expect the same markers back, in the same order.  If the model drops or
mangles markers the renderer would otherwise mis-align translated text with
its rendering boxes — so this module owns the parsing/repair logic.
"""

from __future__ import annotations

import re
from typing import Final

PREFIX: Final[str] = "<<TP_P"
SUFFIX: Final[str] = ">>"

_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(\d+)>>")
_BROKEN_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(?!\d+>>)[^\s>]*>?")


def apply(paragraphs: list[str]) -> str:
    """Encode a list of paragraphs as ``<<TP_Pn>>\\n<text>`` blocks."""
    if not paragraphs:
        return ""
    parts: list[str] = []
    for i, text in enumerate(paragraphs):
        parts.append(f"{PREFIX}{i}{SUFFIX}\n{(text or '').strip()}")
    return "\n\n".join(parts)


def extract_indices(text: str) -> set[int]:
    """Return the set of marker indices present in ``text``."""
    if not text:
        return set()
    out: set[int] = set()
    for m in _MARKER_RE.finditer(text):
        try:
            out.add(int(m.group(1)))
        except (TypeError, ValueError):
            continue
    return out


def has_complete_sequence(ai_text_full: str, expected: int) -> bool:
    """True iff markers 0..expected-1 appear in order in ``ai_text_full``."""
    if expected <= 0:
        return True
    text = ai_text_full or ""
    needed = list(range(expected))
    if sorted(extract_indices(text))[: len(needed)] != needed:
        return False
    last = -1
    for i in needed:
        pos = text.find(f"<<TP_P{i}>>")
        if pos < 0 or pos <= last:
            return False
        last = pos
    return True


def needs_retry(ai_text_full: str, expected: int) -> bool:
    """True when the response is missing markers compared to the input.

    NOTE: we *always* request a retry when at least one marker is missing
    rather than trying to be clever — the LLM is cheap relative to a bad
    user-visible render.
    """
    if expected <= 0:
        return False
    if len(extract_indices(ai_text_full or "")) >= expected:
        return False
    return True


def _collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def sanitize(marked_text: str) -> str:
    """Normalise a raw LLM response into the canonical ``<<TP_Pi>>\\n<text>``
    form expected by :func:`extract_paragraphs`.

    Steps:
    1. Normalise newlines.
    2. Repair broken markers like ``<<TP_P`` or ``<<TP_Pabc`` (drop them).
    3. Ensure each marker sits on its own line.
    4. Re-emit markers in the order they appear.
    """
    text = str(marked_text or "")
    if not text:
        return ""

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _BROKEN_MARKER_RE.sub("", text)
    # Force a newline between a marker and inline content.
    text = re.sub(r"(?m)^\s*(<<TP_P\d+>>)\s*(\S)", r"\1\n\2", text)

    cleaned_lines: list[str] = []
    for line in text.split("\n"):
        if "<<TP_P" not in line:
            cleaned_lines.append(line)
            continue
        only = re.match(r"^\s*(<<TP_P\d+>>)\s*$", line)
        if only:
            cleaned_lines.append(only.group(1))
            continue
        split = re.match(r"^\s*(<<TP_P\d+>>)\s*(.*)$", line)
        if split:
            cleaned_lines.append(split.group(1))
            rest = (split.group(2) or "").strip()
            if rest:
                cleaned_lines.append(rest)
            continue
        cleaned_lines.append(re.sub(r"<<TP_P\d+>>", "", line))

    text = "\n".join(cleaned_lines)

    indices = sorted(extract_indices(text))
    if not indices:
        return _collapse_ws(text)

    out_lines: list[str] = []
    for idx in indices:
        marker = f"<<TP_P{idx}>>"
        m = re.search(rf"{re.escape(marker)}\s*([\s\S]*?)(?=<<TP_P\d+>>|\Z)", text)
        segment = _collapse_ws(m.group(1) if m else "")
        out_lines.append(marker)
        out_lines.append(segment)
        out_lines.append("")
    return "\n".join(out_lines).strip("\n")


def extract_paragraphs(text: str, expected: int) -> tuple[list[str], str] | None:
    """Pull out the paragraph texts in marker order.

    Returns ``(paragraphs, clean_text)`` where ``paragraphs`` has length
    ``expected`` (missing slots are empty strings) and ``clean_text`` is the
    same data joined by ``\\n\\n`` (suitable for storing as ``aiTextFull``).
    Returns ``None`` if no markers are found at all.
    """
    if not text or expected <= 0 or "<<TP_P" not in text:
        return None
    matches = list(_MARKER_RE.finditer(text))
    if not matches:
        return None

    out: list[str] = [""] * expected
    for i, m in enumerate(matches):
        try:
            idx = int(m.group(1))
        except (TypeError, ValueError):
            continue
        seg_start = m.end()
        seg_end = matches[i + 1].start() if (i + 1) < len(matches) else len(text)
        seg = (text[seg_start:seg_end] or "").lstrip("\r\n").strip()
        if 0 <= idx < expected and not out[idx]:
            out[idx] = seg

    return out, "\n\n".join(out)


def repair_with_fallback(
    ai_text_full: str,
    expected: int,
    fallback_paragraphs: list[str] | None = None,
) -> tuple[str, dict]:
    """Reconstruct a fully-marked text when the AI dropped markers.

    For every missing marker, fill the slot from ``fallback_paragraphs``
    (typically the Google-Lens "translatedParagraphs").  Returns the repaired
    text plus metadata (number of markers found / missing, the indices that
    were filled from the fallback, and the per-paragraph provenance).
    """
    fallback_paragraphs = list(fallback_paragraphs or [])
    if len(fallback_paragraphs) < expected:
        fallback_paragraphs = (fallback_paragraphs + [""] * expected)[:expected]
    else:
        fallback_paragraphs = fallback_paragraphs[:expected]

    found = sorted(extract_indices(ai_text_full))
    segment_map: dict[int, str] = {}
    for idx in found:
        if 0 <= idx < expected:
            marker = f"<<TP_P{idx}>>"
            m = re.search(rf"{re.escape(marker)}\s*([\s\S]*?)(?=<<TP_P\d+>>|\Z)", ai_text_full)
            seg = _collapse_ws(m.group(1) if m else "")
            if seg and idx not in segment_map:
                segment_map[idx] = seg

    missing_indices: list[int] = []
    provenance: list[str] = []  # "ai" or "fallback" per paragraph index
    lines: list[str] = []
    for i in range(expected):
        seg = segment_map.get(i) or _collapse_ws(fallback_paragraphs[i] if i < len(fallback_paragraphs) else "")
        if i in segment_map:
            provenance.append("ai")
        else:
            missing_indices.append(i)
            provenance.append("fallback")
        lines.append(f"<<TP_P{i}>>")
        lines.append(seg)
        lines.append("")
    missing = len(missing_indices)

    repaired = "\n".join(lines).strip("\n")
    meta: dict = {
        "marker_repaired": True,
        "marker_expected": expected,
        "marker_found": len(segment_map),
        "marker_missing": missing,
        "marker_missing_indices": missing_indices,
        "marker_provenance": provenance,
    }
    return repaired, meta


def has_meaningful_text(text: str) -> bool:
    """True iff the text contains anything beyond just markers / whitespace."""
    stripped = _MARKER_RE.sub("", str(text or ""))
    return bool(stripped.strip())


def clamp_runaway_repeats(s: str, max_repeat: int = 12) -> str:
    """Collapse runs of the same character longer than ``max_repeat``.

    Some LLMs hallucinate ``"...........................…"`` when they see
    ellipses in dialogue.  Clipping these before a retry stops the model
    from getting "stuck" on the same pattern.
    """
    if not s:
        return ""
    pat = re.compile(r"(.)\1{" + str(max_repeat) + r",}")
    return pat.sub(lambda m: m.group(1) * max_repeat, s)
