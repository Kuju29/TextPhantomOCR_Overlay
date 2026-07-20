"""Low-level text classification / sanitisation used by the renderer.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Kept separate from :mod:`backend.utils.text` because these helpers are tied
to *drawing* concerns (Thai-vs-Latin font selection, control-char stripping)
rather than general text munging.
"""

from __future__ import annotations

import unicodedata

# Thai Unicode block.
_THAI_START = 0x0E00
_THAI_END = 0x0E7F

# A run is a (text, is_thai) pair — used to switch fonts mid-string.
Run = tuple[str, bool | None]


def is_thai_char(ch: str) -> bool:
    """True if ``ch`` is in the Thai Unicode block."""
    return bool(ch) and _THAI_START <= ord(ch) <= _THAI_END


def contains_thai(text: str) -> bool:
    """True if ``text`` contains at least one Thai character."""
    return any(is_thai_char(ch) for ch in text or "")


# Right-to-left Unicode ranges: Hebrew, Arabic (+ supplements) and the
# Arabic presentation forms blocks.
_RTL_RANGES = (
    (0x0590, 0x05FF),  # Hebrew
    (0x0600, 0x06FF),  # Arabic
    (0x0700, 0x074F),  # Syriac
    (0x0750, 0x077F),  # Arabic Supplement
    (0x0780, 0x07BF),  # Thaana
    (0x08A0, 0x08FF),  # Arabic Extended-A
    (0xFB1D, 0xFDFF),  # Hebrew / Arabic presentation forms-A
    (0xFE70, 0xFEFF),  # Arabic presentation forms-B
)


def is_rtl_char(ch: str) -> bool:
    """True if ``ch`` belongs to a right-to-left script block."""
    if not ch:
        return False
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in _RTL_RANGES)


def contains_rtl(text: str) -> bool:
    """True if ``text`` contains at least one right-to-left character."""
    return any(is_rtl_char(ch) for ch in text or "")


def sanitize_draw_text(s: str) -> str:
    """Strip characters Pillow cannot render.

    Removes zero-width spaces / BOMs and all control characters except
    newline, while normalising newline styles.
    """
    t = (s or "").replace("\r\n", "\n").replace("\r", "\n")
    t = t.replace("​", "").replace("﻿", "")
    return "".join(
        ch for ch in t if ch == "\n" or unicodedata.category(ch)[0] != "C"
    )


def split_runs_for_fallback(text: str) -> list[Run]:
    """Split ``text`` into maximal Thai / non-Thai runs.

    Whitespace inherits the current run's script so a space between two Thai
    words doesn't force a font switch.  Newlines become their own ``("\\n",
    None)`` run.  The renderer draws each run with the matching font.
    """
    runs: list[Run] = []
    cur: list[str] = []
    cur_is_thai: bool | None = None

    for ch in text:
        if ch == "\n":
            if cur:
                runs.append(("".join(cur), cur_is_thai))
                cur = []
            runs.append(("\n", None))
            cur_is_thai = None
            continue

        is_thai = is_thai_char(ch)
        if ch.isspace() and cur_is_thai is not None:
            is_thai = cur_is_thai

        if cur_is_thai is None:
            cur_is_thai = is_thai
            cur = [ch]
        elif is_thai == cur_is_thai:
            cur.append(ch)
        else:
            runs.append(("".join(cur), cur_is_thai))
            cur = [ch]
            cur_is_thai = is_thai

    if cur:
        runs.append(("".join(cur), cur_is_thai))
    return runs
