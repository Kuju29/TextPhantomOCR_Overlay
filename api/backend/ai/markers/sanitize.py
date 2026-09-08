from __future__ import annotations
from typing import Final

import re

from .wire import PREFIX, normalize_unit_text

_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(\d+)>>")
_BROKEN_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(?!\d+>>)[^\s>]*>?")
MEMO_MARKER: Final[str] = "<<TP_MEMO>>"

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

def split_memo(text: str) -> tuple[str, str]:
    """Split off the optional trailing ``<<TP_MEMO>>`` character-notes block.

    The prompt asks the model to append character observations (name, gender,
    speech style) after the last paragraph, behind a ``<<TP_MEMO>>`` marker.
    Returns ``(text_without_memo, memo_text)``; ``memo_text`` is ``""`` when
    the block is absent.  Everything from the FIRST memo marker onward is
    treated as memo so a stray duplicate can never leak into the render.
    """
    t = text or ""
    if MEMO_MARKER not in t:
        return t, ""
    body, _, memo = t.partition(MEMO_MARKER)
    memo = memo.replace(MEMO_MARKER, "\n").strip()
    return body.rstrip(), memo

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
        return normalize_unit_text(text)

    out_lines: list[str] = []
    for idx in indices:
        marker = f"<<TP_P{idx}>>"
        m = re.search(rf"{re.escape(marker)}\s*([\s\S]*?)(?=<<TP_P\d+>>|\Z)", text)
        segment = normalize_unit_text(m.group(1) if m else "")
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
        # Some providers mix real marker newlines with literal escaped line
        # breaks inside a segment.  They are provider formatting, not bubble
        # geometry; normalize them before the shared whitespace collapse.
        raw_seg = re.sub(r"\\r\\n|\\n|\\r", " ", text[seg_start:seg_end])
        seg = normalize_unit_text(raw_seg)
        if 0 <= idx < expected and not out[idx]:
            out[idx] = seg

    return out, "\n\n".join(out)

def extract_paragraphs_exact(text: str, expected: int) -> tuple[list[str], str] | None:
    """Decode framing created by :func:`apply` without mutating source text."""
    source = str(text or "")
    matches = list(_MARKER_RE.finditer(source))
    if not matches or len(matches) != expected:
        return None
    out: list[str] = [""] * expected
    for position, match in enumerate(matches):
        idx = int(match.group(1))
        start = match.end()
        if idx != position or not source.startswith("\n", start):
            return None
        start += 1
        end = matches[position + 1].start() if position + 1 < len(matches) else len(source)
        if position + 1 < len(matches):
            if source[end - 2:end] != "\n\n":
                return None
            end -= 2
        out[idx] = source[start:end]
    return out, "\n\n".join(out)

# Whether a unit holds prose a translator can act on, i.e. at least one letter.
# Mirrors `hasTranslatableText` in src/shared/lens-document.js.
def has_translatable_text(text: str) -> bool:
    return any(ch.isalpha() for ch in str(text or ""))

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

def clamp_output_repeats(
    s: str, max_char_repeat: int = 12, max_cluster_repeat: int = 4
) -> str:
    """Bound pathological character and short-cluster repetition."""
    if not s:
        return ""
    s = clamp_runaway_repeats(s, max_char_repeat)
    pattern = re.compile(r"(.{2,16}?)\1{" + str(max_cluster_repeat) + r",}", re.DOTALL)
    previous = None
    while previous != s:
        previous = s
        s = pattern.sub(lambda match: match.group(1) * max_cluster_repeat, s)
    return s
