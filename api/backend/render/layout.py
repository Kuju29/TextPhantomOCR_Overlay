"""Text layout helpers for the AI layer: tokenising and template-mirrored distribution.

- :func:`tokens_with_spaces` splits text into word/space tokens per language:
  Latin keeps whitespace words, Thai uses BudouX phrase chunks, JA/ZH/KO break
  at every character so scriptio-continua text always has a break point
  (after manga-image-translator's ``calc_horizontal``).
- :func:`distribute_to_template` pours AI text into the template items in the
  proportions Lens itself used for the paragraph.
"""

from __future__ import annotations

from typing import Final

import re, math

from backend.render.geometry import ensure_box_fields


# Token tuples.
RawToken = tuple[str, str]               # (kind, text)
LineToken = tuple[str, str, float]       # (kind, text, width_px)

# Languages whose orthography has no inter-word spaces. When the target
# language belongs to this set we strip stray spaces that sit between two
# adjacent same-script characters — this happens often in AI output ("ไม่ มี"
# instead of "ไม่มี") and Lens HTML never has them. Spaces touching Latin
# letters or digits are preserved (e.g. "อันดับ 10").
_NO_SPACE_SCRIPTS = frozenset(
    {"th", "ja", "ko", "zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant"}
)

# Unicode ranges covered by ``_NO_SPACE_SCRIPTS``:
# - Thai (0E00-0E7F)
# - CJK Unified Ideographs (4E00-9FFF) + CJK Symbols and Punctuation (3000-303F)
# - Hiragana (3040-309F), Katakana (30A0-30FF)
# - Hangul Syllables (AC00-D7A3)
_NO_SPACE_CHARS = (
    r"฀-๿　-〿぀-ゟ゠-ヿ一-鿿가-힣"
)
_INTRA_SCRIPT_SPACE_RE = re.compile(
    rf"([{_NO_SPACE_CHARS}])\s+(?=[{_NO_SPACE_CHARS}])"
)


# Latin / European scripts whose orthography uses inter-word spaces. When
# the target is one of these we keep BudouX out of the picture entirely and
# treat each whitespace-delimited run as a single "word" token — exactly how
# manga-image-translator's ``calc_horizontal`` handles ``language='en_US'``.
_LATIN_LANGS = frozenset(
    {
        "en", "id", "ms", "vi", "tl", "fil",
        "es", "pt", "pt-br", "pt-pt",
        "fr", "de", "it", "nl", "sv", "no", "nb", "da", "fi", "is",
        "pl", "cs", "sk", "hu", "ro", "tr",
    }
)

# Scriptio-continua scripts that benefit from single-character tokens. We
# already collapse intra-script whitespace via :data:`_INTRA_SCRIPT_SPACE_RE`;
# in addition, when no BudouX parser is available (or for ZH/KO where BudouX
# doesn't help much) we hand the wrapper one token per character so a line
# break can always land exactly where it has to.
_CHAR_LEVEL_LANGS = frozenset(
    {"ja", "ko", "zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant"}
)

# Half-width small kana (Japanese): visually narrower than the average
# character, so when we compute "how much text mass" an item should hold we
# count them as half a unit.  This mirrors manga-image-translator's
# ``count_text_length`` (``rendering/__init__.py``) and keeps the AI
# distribution from over-weighting items whose template text is mostly small
# kana — common in Japanese onomatopoeia.
_HALF_WIDTH_CHARS: Final[frozenset[str]] = frozenset("っッぁぃぅぇぉゃゅょャュョ")

def count_text_length(text: str) -> float:
    """Visual text length, with half-width chars counted as 0.5.

    Used by :func:`_item_weight` so the AI distribution mirrors Lens's split
    proportionally to *visible* text mass rather than raw codepoint count.
    """
    if not text:
        return 0.0
    total = 0.0
    for ch in text:
        if ch.isspace():
            continue
        total += 0.5 if ch in _HALF_WIDTH_CHARS else 1.0
    return total

def font_size_minimum_for_image(img_w: int, img_h: int) -> int:
    """Readability floor for the AI fit pass.

    manga-image-translator uses ``(img.shape[0] + img.shape[1]) / 200`` as its
    minimum font size when no explicit fixed size is given.  That heuristic
    assumes a page-shaped image; on a long manhwa/webtoon STRIP (e.g.
    800 x 12000 px) the height term explodes the floor to 60+ px and every AI
    paragraph renders huge.  Glyph size should follow the *reading* dimension
    (the width), so the longer side's contribution is capped at 2x the shorter
    side — identical to the original behaviour for normal page shapes, sane
    for strips.  The minimum is 8px so tiny thumbnails still produce legible
    spans.
    """
    w = max(0, int(img_w))
    h = max(0, int(img_h))
    short, long_ = (w, h) if w <= h else (h, w)
    side_sum = short + min(long_, 2 * short)
    return max(8, int(round(side_sum / 200.0)))

def _normalise_lang(lang: str) -> str:
    """Lowercase + ``_``→``-`` so language comparisons are robust."""
    return (lang or "").strip().lower().replace("_", "-")

def collapse_intra_script_spaces(text: str, lang: str) -> str:
    """Remove spaces between adjacent CJK / Thai characters.

    Thai, Japanese, Chinese and Korean don't put spaces between words. AI
    output (and sometimes the source itself) sneaks them in — left alone they
    show up as visible gaps once each token becomes its own ``.tp-span`` div.
    Spaces between *different* scripts (Thai + Latin, CJK + digits, …) are
    kept so things like "อันดับ 10" still render correctly.
    """
    if not text:
        return ""
    if _normalise_lang(lang) not in _NO_SPACE_SCRIPTS:
        return text
    # The regex eats *only* the whitespace between two same-script chars, in
    # one left-to-right sweep that handles arbitrarily long Thai/CJK runs.
    return _INTRA_SCRIPT_SPACE_RE.sub(r"\1", text)

def _split_word_for_lang(word: str, parser, code: str) -> list[str]:
    """Per-language strategy that turns a single non-whitespace run into one
    or more "word" segments.

    - Latin / European: return the whole run as a single segment — the natural
      break points already came from whitespace.
    - Thai: hand the run to BudouX when available, falling back to whole-run.
    - JA/ZH/KO (scriptio continua): break at every character so the wrapper
      always has somewhere to break, matching what
      ``manga-image-translator``'s ``calc_horizontal`` does when no hyphenator
      exists for the language.
    - Anything else: BudouX if available, else whole-run.
    """
    if not word:
        return []
    if code in _LATIN_LANGS:
        return [word]
    if code in _CHAR_LEVEL_LANGS:
        # One char per token; punctuation stays attached to the previous
        # character so it never starts a new visual line.
        out: list[str] = []
        for ch in word:
            if out and not ch.isalnum() and ord(ch) < 0x3000:
                # ASCII / Latin-1 punctuation glues to the previous segment.
                out[-1] = out[-1] + ch
            else:
                out.append(ch)
        return out
    if parser is not None:
        try:
            segs = [seg for seg in parser.parse(word) if seg]
            return segs or [word]
        except Exception:
            return [word]
    return [word]

def tokens_with_spaces(text: str, parser, lang: str) -> list[RawToken]:
    """Split ``text`` into ``(kind, text)`` tokens.

    Whitespace runs become ``("space", ...)`` tokens; everything else is sent
    through :func:`_split_word_for_lang`, which picks a per-language strategy:
    Latin keeps whole words, JA/ZH/KO splits per character, Thai uses BudouX.
    For no-space scripts the input is normalised first via
    :func:`collapse_intra_script_spaces` so a stray space between two Thai or
    CJK characters doesn't sneak through as a token.
    """
    t = collapse_intra_script_spaces(text or "", lang)
    if not t:
        return []
    code = _normalise_lang(lang)
    out: list[RawToken] = []
    for part in re.findall(r"\s+|\S+", t):
        if not part:
            continue
        if part.isspace():
            out.append(("space", part))
            continue
        out.extend(("word", seg) for seg in _split_word_for_lang(part, parser, code))
    return out


def _line_cap_px(item: dict, img_w: int, img_h: int) -> float:
    """Maximum line width (px) for an item — its baseline length, or box width."""
    p1 = item.get("baseline_p1") or {}
    p2 = item.get("baseline_p2") or {}
    dx = (float(p2.get("x") or 0.0) - float(p1.get("x") or 0.0)) * img_w
    dy = (float(p2.get("y") or 0.0) - float(p1.get("y") or 0.0)) * img_h
    cap = math.hypot(dx, dy)
    if cap > 1e-6:
        return cap
    box = ensure_box_fields(item.get("box") or {})
    return float(box.get("width") or 0.0) * img_w


def pad_lines(lines: list[list[LineToken]], max_lines: int) -> list[list[LineToken]]:
    """Truncate or pad ``lines`` to exactly ``max_lines`` entries."""
    max_lines = int(max_lines)
    if max_lines <= 0:
        return []
    lines = list(lines or [])
    if len(lines) > max_lines:
        return lines[:max_lines]
    if len(lines) < max_lines:
        lines.extend([[] for _ in range(max_lines - len(lines))])
    return lines

# --- Template-mirrored distribution ---------------------------------------
# Instead of greedily wrapping AI text to *fit* the item boxes (which often
# crams one line and empties another), we mirror how Lens itself split the
# paragraph: each template item already carries a slice of the Lens
# translation, and the length of that slice tells us the share of text that
# line should hold. Distributing the AI text by those same proportions
# reproduces Lens's line breaks — which were chosen to suit the speech bubble.

def _item_weight(item: dict, img_w: int, img_h: int) -> float:
    """How much of the paragraph this template item should hold.

    Primary signal: the visual text length of the item's own (Lens) text —
    small kana count as 0.5 (see :func:`count_text_length`), so an item full
    of Japanese sokuon doesn't disproportionately attract AI characters.
    Fallback when the item has no text: its baseline length in pixels.
    """
    text = str(item.get("text") or "").strip()
    if text:
        return max(1.0, count_text_length(text))
    cap = _line_cap_px(item, img_w, img_h)
    return cap if cap > 1e-6 else 1.0

def distribute_to_template(
    para_text: str,
    template_items: list[dict],
    parser,
    lang: str,
    img_w: int,
    img_h: int,
) -> list[list[LineToken]]:
    """Split ``para_text`` into one line per template item, mirroring how Lens
    distributed the same paragraph across those items.

    Returns exactly ``len(template_items)`` token lines. Words are never split;
    the cut between two items happens at the word boundary closest to the
    target character offset (weighted by :func:`_item_weight`).
    """
    n = len(template_items)
    if n == 0:
        return []

    tokens = tokens_with_spaces(para_text, parser, lang)
    words = [(k, s) for k, s in tokens]  # keep spaces for natural rendering

    if n == 1:
        return [[(k, s, 0.0) for k, s in words]]

    # Per-item targets as a cumulative fraction of the total word-character
    # mass.  Both sides of the ratio use :func:`count_text_length` so a
    # template item full of small kana isn't asked to absorb a disproportionate
    # share of the AI text.
    weights = [_item_weight(it, img_w, img_h) for it in template_items]
    total_w = sum(weights) or 1.0
    total_mass = sum(count_text_length(s) for k, s in words if k == "word") or 1.0
    cumulative = 0.0
    targets: list[float] = []
    for w in weights:
        cumulative += w
        targets.append(total_mass * cumulative / total_w)

    lines: list[list[LineToken]] = [[] for _ in range(n)]
    li = 0
    mass_so_far = 0.0

    for kind, s in words:
        if kind == "space":
            if lines[li]:  # never start a line with a space
                lines[li].append((kind, s, 0.0))
            continue
        # Move to the next item once we've passed this item's target — using
        # the word's *midpoint* so a word straddling the boundary lands on
        # whichever side it is mostly on.
        w_mass = count_text_length(s)
        if li < n - 1 and lines[li] and (mass_so_far + w_mass / 2.0) > targets[li]:
            li += 1
            while lines[li - 1] and lines[li - 1][-1][0] == "space":
                lines[li - 1].pop()
        lines[li].append((kind, s, 0.0))
        mass_so_far += w_mass

    # Trim leading/trailing spaces from every line.
    for line in lines:
        while line and line[0][0] == "space":
            line.pop(0)
        while line and line[-1][0] == "space":
            line.pop()
    return lines

