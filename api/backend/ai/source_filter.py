"""Decide source eligibility without changing the captured source text."""
import unicodedata

# Unicode Default_Ignorable_Code_Point ranges, including reserved tag/selector
# code points. Cc/Cf and White_Space are excluded independently below. This
# matches the extension's Unicode-property predicate without a new dependency.
_DEFAULT_IGNORABLE = (
    (0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C),
    (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F),
    (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F),
    (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF),
)


def has_letters(text: str) -> bool:
    """Output/content conservation permits a valid single-letter answer."""
    return any(unicodedata.category(ch).startswith('L') for ch in str(text or ''))


def _visible_points(text: str) -> list[str]:
    return [ch for ch in text
        if not ch.isspace() and unicodedata.category(ch) not in ('Cc', 'Cf')
        and not any(start <= ord(ch) <= end for start, end in _DEFAULT_IGNORABLE)]


def has_translatable_text(text: str) -> bool:
    """Require two original visible points as well as meaningful NFC text."""
    original = str(text or '')
    # NFC can expand a single scalar (for example DEVANAGARI LETTER QA).
    # It must not turn that original singleton into an eligible source unit.
    if len(original) < 2 or len(_visible_points(original)) < 2:
        return False
    visible = _visible_points(unicodedata.normalize('NFC', original))
    return len(visible) >= 2 and has_letters(''.join(visible))
