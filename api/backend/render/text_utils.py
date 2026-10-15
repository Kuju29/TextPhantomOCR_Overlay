"""Low-level text classification / sanitisation used by the renderer.

Kept separate from :mod:`backend.utils.text` because these helpers are tied
to *drawing* concerns (Thai-vs-Latin font selection, control-char stripping)
rather than general text munging.
"""

from __future__ import annotations


# Thai Unicode block.
_THAI_START = 0x0E00
_THAI_END = 0x0E7F


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

