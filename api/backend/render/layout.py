"""Text layout: tokenising, line-wrapping, font-fitting and span placement.

The renderer's job is to pour translated text back into the *boxes* of the
original OCR items.  This module owns that pour:

- :func:`tokens_with_spaces`   — split text into word / space tokens, with a
  per-language strategy: Latin keeps real whitespace words, Thai uses BudouX
  phrase-level chunks, and JA/ZH/KO break at every character so scriptio-
  continua scripts always have a break point available.
- :func:`wrap_tokens_to_lines` — greedily wrap tokens into per-item lines,
  respecting each item's pixel width "cap".
- :func:`fit_para_size_and_lines` — shrink the font until every line fits its
  item's height.
- :func:`distribute_to_template` — mirror Lens's own per-item word
  distribution by pouring AI text into the template proportionally.
- :func:`apply_line_to_item`   — given a line of tokens, write ``spans`` (with
  pixel boxes) back onto an item.

A *line token* is a ``(kind, text, width_px)`` tuple where ``kind`` is
``"word"`` or ``"space"``.

The per-language token strategy here is inspired by manga-image-translator's
``calc_horizontal`` (see ``manga_translator/rendering/text_render.py``): for
languages with a hyphenator (Latin) we keep whole words and only split when
they overflow; for languages without one (JA/ZH/KO) we pre-split into single
characters so the wrapper always has a legal break point.  Thai sits in
between — BudouX gives us phrase-level chunks that are far better than naive
character splits, but the chunks are short enough that wrapping never gets
stuck.
"""

from __future__ import annotations

import math
import re
from typing import Any, Final

from PIL import Image, ImageDraw

from backend.render.fonts import is_truetype, pick_font
from backend.render.geometry import ensure_box_fields
from backend.render.text_metrics import baseline_offset_px, line_metrics_px
from backend.render.text_utils import contains_thai, sanitize_draw_text
from backend.utils.text import ZWSP

# A reusable scratch draw context for width measurement.
_SCRATCH = ImageDraw.Draw(Image.new("RGBA", (10, 10), (0, 0, 0, 0)))

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


def _measure_width(font, text: str) -> float:
    """Pixel advance width of ``text`` in ``font`` (robust to old Pillow)."""
    try:
        return float(font.getlength(text))
    except Exception:
        try:
            bb = _SCRATCH.textbbox((0, 0), text, font=font, anchor="ls")
            return float(bb[2] - bb[0])
        except Exception:
            w, _ = _SCRATCH.textsize(text, font=font)  # type: ignore[attr-defined]
            return float(w)


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


def wrap_tokens_to_lines(
    tokens: list[RawToken],
    items: list[dict],
    img_w: int,
    img_h: int,
    thai_font: str,
    latin_font: str,
    font_size: int,
    min_lines: int,
) -> list[list[LineToken]]:
    """Greedily wrap ``tokens`` into at most ``len(items)`` lines.

    Each line's width budget is the matching item's :func:`_line_cap_px`.  A
    "soft cap" (90%) is applied to early lines when more than one line is
    desired, so text distributes more evenly instead of cramming line one.
    Leading/trailing space tokens are trimmed from every line.
    """
    max_lines = len(items)
    if max_lines <= 0:
        return []

    caps = [_line_cap_px(it, img_w, img_h) for it in items]
    desired = max(1, min(int(min_lines), max_lines))
    soft_factor = 0.90 if desired > 1 else 1.0

    lines: list[list[LineToken]] = [[]]
    cur_w = 0.0
    li = 0
    last_word_hint = ""
    pending_space = ""

    def cap_for_line(idx: int) -> float:
        return float(caps[min(idx, max_lines - 1)])

    for kind, s in tokens or []:
        if kind == "space":
            if lines[-1]:  # ignore leading spaces
                pending_space += str(s)
            continue
        if kind != "word":
            continue
        txt = str(s)
        if not txt:
            continue

        word_w = _measure_width(pick_font(txt, thai_font, latin_font, int(font_size)), txt)

        space_w = 0.0
        if pending_space:
            hint = last_word_hint or txt
            space_w = _measure_width(
                pick_font(hint, thai_font, latin_font, int(font_size)), pending_space
            )

        cap = cap_for_line(li)
        soft_cap = cap * soft_factor if (li < desired and cap > 0.0) else cap
        need_w = cur_w + space_w + word_w

        # Break to the next line if this word overflows the (soft) cap.
        if lines[-1] and li < max_lines - 1:
            if (cap > 0.0 and need_w > cap) or (soft_cap > 0.0 and need_w > soft_cap):
                lines.append([])
                li += 1
                cur_w = 0.0
                pending_space = ""
                space_w = 0.0

        if pending_space and lines[-1]:
            lines[-1].append(("space", pending_space, space_w))
            cur_w += space_w
            pending_space = ""

        lines[-1].append(("word", txt, word_w))
        cur_w += word_w
        last_word_hint = txt

    # Overflow lines get merged into the last allowed line.
    if len(lines) > max_lines:
        head = lines[: max_lines - 1]
        tail: list[LineToken] = []
        for seg in lines[max_lines - 1 :]:
            tail.extend(seg)
        lines = head + [tail]

    # Trim leading/trailing spaces per line.
    for i, line in enumerate(lines):
        while line and line[0][0] == "space":
            line = line[1:]
        while line and line[-1][0] == "space":
            line = line[:-1]
        lines[i] = line

    return lines


def ensure_min_lines_by_split(
    lines: list[list[LineToken]], min_lines: int, max_lines: int
) -> list[list[LineToken]]:
    """Split the wordiest lines until ``min_lines`` (capped at ``max_lines``)."""
    if not lines:
        return []
    min_lines = int(min_lines)
    max_lines = int(max_lines)
    if min_lines <= 1:
        return lines

    target = min(min_lines, max_lines)
    lines = [list(seg) for seg in lines]

    def trim(seg: list[LineToken]) -> list[LineToken]:
        while seg and seg[0][0] == "space":
            seg.pop(0)
        while seg and seg[-1][0] == "space":
            seg.pop()
        return seg

    while len(lines) < target:
        # Find the line with the most splittable words.
        idx = None
        best = 0
        for i, seg in enumerate(lines):
            n_words = sum(1 for k, s, _ in seg if k == "word" and s != ZWSP)
            if n_words > best and n_words > 1:
                best = n_words
                idx = i
        if idx is None:
            break

        seg = lines[idx]
        word_positions = [i for i, (k, s, _) in enumerate(seg) if k == "word" and s != ZWSP]
        if len(word_positions) <= 1:
            break
        cut_pos = word_positions[len(word_positions) // 2]

        lines[idx] = trim(seg[:cut_pos])
        lines.insert(idx + 1, trim(seg[cut_pos:]))
        if len(lines) >= max_lines:
            break

    return lines


def fit_para_size_and_lines(
    ptext: str,
    parser,
    items: list[dict],
    img_w: int,
    img_h: int,
    thai_font: str,
    latin_font: str,
    base_size: int,
    min_lines: int,
    lang: str,
) -> tuple[int, list[list[LineToken]]]:
    """Find the largest font size at which ``ptext`` fits the item boxes.

    Returns ``(font_size, wrapped_lines)``.  Tries ``base_size`` down to 10,
    accepting the first size where every line's measured height fits its
    item's box height.  Falls back to size 10 if nothing fits.
    """
    tokens = tokens_with_spaces(ptext, parser, lang)
    if not tokens or not items:
        return int(base_size), [[] for _ in items]

    max_lines = len(items)
    n_words = sum(1 for k, s in tokens if k == "word" and str(s))
    desired_lines = max(1, min(max_lines, n_words))

    heights = [
        float(ensure_box_fields(it.get("box") or {}).get("height") or 0.0) * img_h
        for it in items
    ]

    size = max(10, int(base_size))
    while size >= 10:
        lines = wrap_tokens_to_lines(
            tokens, items, img_w, img_h, thai_font, latin_font, size, min_lines=desired_lines
        )
        lines = ensure_min_lines_by_split(lines, desired_lines, max_lines)

        if len(lines) <= max_lines:
            fits = True
            for ii, seg in enumerate(lines):
                words = [s for k, s, _ in seg if k == "word" and s != ZWSP]
                if not words:
                    continue
                metrics = line_metrics_px("".join(words), thai_font, latin_font, size)
                if metrics is None:
                    continue
                _w, line_h, _c = metrics
                if ii < len(heights) and heights[ii] > 0.0 and line_h > heights[ii] * 1.01:
                    fits = False
                    break
            if fits:
                return size, lines
        size -= 1

    lines10 = wrap_tokens_to_lines(
        tokens, items, img_w, img_h, thai_font, latin_font, 10, min_lines=desired_lines
    )
    lines10 = ensure_min_lines_by_split(lines10, desired_lines, max_lines)
    return 10, lines10


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


def fit_font_size_for_lines(
    lines: list[list[LineToken]],
    items: list[dict],
    img_w: int,
    img_h: int,
    thai_font: str,
    latin_font: str,
    base_size: int,
    lang: str,
    min_size_px: int | None = None,
) -> int:
    """Largest font size (>=floor) at which every fixed line fits its item height.

    The line distribution is already decided (see :func:`distribute_to_template`)
    so this only searches for a size — it never re-wraps. Per-item width fitting
    is handled later by ``backend.render.tp_html.fit_tree_font_sizes``.

    ``min_size_px`` is the readability floor; defaults to
    :func:`font_size_minimum_for_image` for the supplied ``img_w``/``img_h``.
    The smallest value ever returned is 8 so tiny thumbnails still produce
    legible spans even when the box height is microscopic.
    """
    heights = [
        float(ensure_box_fields(it.get("box") or {}).get("height") or 0.0) * img_h
        for it in items
    ]
    floor = int(min_size_px) if min_size_px is not None else font_size_minimum_for_image(img_w, img_h)
    floor = max(8, floor)
    size = max(floor, int(base_size))
    while size >= floor:
        fits = True
        for ii, seg in enumerate(lines):
            words = [s for k, s, _ in seg if k == "word" and s != ZWSP]
            if not words:
                continue
            metrics = line_metrics_px("".join(words), thai_font, latin_font, size)
            if metrics is None:
                continue
            _w, line_h, _c = metrics
            if ii < len(heights) and heights[ii] > 0.0 and line_h > heights[ii] * 1.01:
                fits = False
                break
        if fits:
            return size
        size -= 1
    return floor


def apply_line_to_item(
    item: dict,
    line_tokens: list[LineToken],
    para_index: int,
    item_index: int,
    abs_line_start_raw: int,
    W: int,
    H: int,
    thai_path: str,
    latin_path: str,
    forced_size_px: int | None,
    apply_baseline_shift: bool = True,
    kerning_adjust: bool = False,
) -> None:
    """Write ``spans`` (and updated ``box`` / ``font_size_px``) onto ``item``.

    Places each token along the item's baseline, scaling the font so the line
    fits the box.  When ``forced_size_px`` is given the font size is fixed and
    only horizontal scaling is applied.  Mutates ``item`` in place.
    """
    # Normalise raw tuples to (kind, text, width) triples.
    tokens: list[LineToken] = []
    for t in line_tokens or []:
        if not isinstance(t, (list, tuple)) or len(t) < 2:
            continue
        w = float(t[2]) if len(t) > 2 and isinstance(t[2], (int, float)) else 0.0
        tokens.append((str(t[0]), str(t[1]), w))

    words = [s for k, s, _ in tokens if k == "word" and s != ZWSP]
    item_text = "".join(s for _, s, _ in tokens if s != ZWSP).strip()
    item["text"] = item_text
    item["valid_text"] = bool(item_text)

    box = ensure_box_fields(item.get("box") or {})
    item["box"] = box
    base_left = float(box.get("left") or 0.0)
    base_top = float(box.get("top") or 0.0)
    base_w = float(box.get("width") or 0.0)
    base_h = float(box.get("height") or 0.0)

    if not words or base_w <= 0.0 or base_h <= 0.0 or W <= 0 or H <= 0:
        item["spans"] = []
        return

    # Baseline endpoints in pixels.
    p1 = item.get("baseline_p1") or {}
    p2 = item.get("baseline_p2") or {}
    x1 = float(p1.get("x") or 0.0) * W
    y1 = float(p1.get("y") or 0.0) * H
    x2 = float(p2.get("x") or 0.0) * W
    y2 = float(p2.get("y") or 0.0) * H

    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length <= 1e-9:
        item["spans"] = []
        return

    ux, uy = dx / length, dy / length
    nx, ny = -uy, ux
    if ny < 0:
        nx, ny = -nx, -ny

    base_w_px = length
    base_h_px = base_h * H
    base_size = 96  # measure at a fixed reference size, then scale

    # If a real TTF/OTF is unavailable Pillow falls back to a bitmap default
    # whose ``textbbox`` ignores the requested size — every measurement
    # becomes the same tiny number, which makes ``scale_line`` (and the
    # downstream fit-size) explode. Detect that here and use a height-based
    # heuristic + equal proportional shares per word: visually similar to
    # what Lens emits, and recoverable once the font finally loads.
    if not is_truetype(pick_font(item_text or "a", thai_path, latin_path, base_size)):
        final_size = int(forced_size_px) if forced_size_px else max(10, int(base_h_px * 0.85))
        item["font_size_px"] = final_size
        word_count = sum(1 for k, _s, _w in tokens if k == "word")
        if word_count <= 0:
            item["spans"] = []
            return
        equal_share = 1.0 / word_count
        spans: list[dict[str, Any]] = []
        raw_pos = 0
        span_i = 0
        cum_t = 0.0
        for kind, s, _ in tokens:
            if s == ZWSP:
                continue
            start_raw = abs_line_start_raw + raw_pos
            raw_pos += len(s)
            end_raw = abs_line_start_raw + raw_pos
            if kind != "word":
                continue
            t0 = cum_t
            cum_t += equal_share
            t1 = cum_t
            seg_start_px = t0 * base_w_px
            seg_end_px = t1 * base_w_px
            e1x = x1 + ux * seg_start_px
            e1y = y1 + uy * seg_start_px
            e2x = x1 + ux * seg_end_px
            e2y = y1 + uy * seg_end_px
            span_cx = (e1x + e2x) / 2.0
            span_cy = (e1y + e2y) / 2.0
            span_w_px = (t1 - t0) * base_w_px
            span_box = ensure_box_fields(
                {
                    "left": (span_cx - span_w_px / 2.0) / W,
                    "top": (span_cy - base_h_px / 2.0) / H,
                    "width": span_w_px / W,
                    "height": base_h_px / H,
                    "rotation_deg": float(box.get("rotation_deg") or 0.0),
                    "rotation_deg_css": float(box.get("rotation_deg_css") or 0.0),
                    "center": {"x": span_cx / W, "y": span_cy / H},
                }
            )
            spans.append(
                {
                    "side": "Ai",
                    "para_index": para_index,
                    "item_index": item_index,
                    "span_index": span_i,
                    "text": s,
                    "valid_text": True,
                    "start_raw": start_raw,
                    "end_raw": end_raw,
                    "t0_raw": t0,
                    "t1_raw": t1,
                    "box": span_box,
                    "height_raw": item.get("height_raw"),
                    "baseline_p1": item.get("baseline_p1"),
                    "baseline_p2": item.get("baseline_p2"),
                    "font_size_px": final_size,
                }
            )
            span_i += 1
        item["spans"] = spans
        return

    # --- Build layout units and measure each at the reference size --------
    layout_units: list[tuple[str, str]] = []
    for k, s, _ in tokens:
        if s == ZWSP:
            continue
        if k in ("space", "word"):
            layout_units.append((k, sanitize_draw_text(s)))

    widths_px: list[float] = []
    max_ascent = 0
    max_descent = 0

    for i, (kind, text) in enumerate(layout_units):
        if kind == "space":
            # A space's width depends on the font of an adjacent word.
            hint = ""
            for j in range(i - 1, -1, -1):
                if layout_units[j][0] == "word":
                    hint = layout_units[j][1]
                    break
            if not hint:
                for j in range(i + 1, len(layout_units)):
                    if layout_units[j][0] == "word":
                        hint = layout_units[j][1]
                        break
            font = pick_font(hint or "a", thai_path, latin_path, base_size)
            widths_px.append(max(0.0, _measure_width(font, text)))
            continue

        font = pick_font(text, thai_path, latin_path, base_size)
        try:
            ascent, descent = font.getmetrics()
        except Exception:
            ascent, descent = base_size, int(base_size * 0.25)
        max_ascent = max(max_ascent, ascent)
        max_descent = max(max_descent, descent)

        # Optional kerning: measure word+next-char minus next-char so adjacent
        # words of the same script tuck together naturally.
        if (
            kerning_adjust
            and (i + 1) < len(layout_units)
            and layout_units[i + 1][0] == "word"
        ):
            nxt = layout_units[i + 1][1]
            nxt1 = nxt[:1] if nxt else ""
            if nxt1 and contains_thai(text) == contains_thai(nxt1):
                width = _measure_width(font, text + nxt1) - _measure_width(font, nxt1)
            else:
                width = _measure_width(font, text)
        else:
            width = _measure_width(font, text)
        widths_px.append(max(0.0, width))

    line_tw = sum(widths_px)
    bo_base = baseline_offset_px(item_text, thai_path, latin_path, base_size)
    line_th = float(bo_base[1]) if bo_base is not None else float(max_ascent + max_descent)

    if line_tw <= 1e-9 or line_th <= 1e-9:
        item["spans"] = []
        return

    # --- Decide the final font size ---------------------------------------
    if forced_size_px is None:
        scale_line = min((base_w_px * 1.0) / line_tw, (base_h_px * 0.995) / line_th)
        if scale_line <= 0.0:
            item["spans"] = []
            return
        final_size = max(10, int(base_size * scale_line))
    else:
        final_size = int(max(10, forced_size_px))
        scale_line = final_size / base_size

    item["font_size_px"] = final_size

    # Lens-style span tiling: each span's box covers a slice of the item
    # baseline proportional to that token's natural width, so all spans
    # together fill the full item width (no leftover "margin" pockets like
    # the previous centre-and-pad layout produced). Within each span the
    # CSS flex centring renders the text at its natural size — visually
    # matching how Google Lens lays out its own overlays.
    w_scaled = [w * scale_line for w in widths_px]
    _proportion_total = sum(widths_px) or 1.0
    _shares = [w / _proportion_total for w in widths_px]

    # --- Optionally shift the baseline so text is vertically centred ------
    bo = baseline_offset_px(item_text, thai_path, latin_path, final_size)
    if apply_baseline_shift and bo is not None:
        baseline_offset, _ = bo
        cx = (base_left + base_w / 2.0) * W
        cy = (base_top + base_h / 2.0) * H
        target = (cx + baseline_offset * nx, cy + baseline_offset * ny)
        shift = ((target[0] - x1) * nx) + ((target[1] - y1) * ny)
        x1 += nx * shift
        y1 += ny * shift
        x2 += nx * shift
        y2 += ny * shift
        item["baseline_p1"] = {"x": x1 / W, "y": y1 / H}
        item["baseline_p2"] = {"x": x2 / W, "y": y2 / H}

    # --- Emit spans -------------------------------------------------------
    # t0/t1 are proportional positions along the item baseline (0..1).
    # Together every token's slice — words *and* spaces — sums to 1, so the
    # spans tile the item width exactly the way Lens's own decoded spans do.
    spans: list[dict[str, Any]] = []
    raw_pos = 0
    span_i = 0
    unit_i = 0
    cum_t = 0.0

    for kind, s, _ in tokens:
        if s == ZWSP:
            continue
        start_raw = abs_line_start_raw + raw_pos
        raw_pos += len(s)
        end_raw = abs_line_start_raw + raw_pos

        if unit_i >= len(_shares):
            break
        t0 = cum_t
        cum_t += _shares[unit_i]
        t1 = cum_t
        unit_i += 1

        if kind == "space":
            continue

        # Compute the span's image-space box from its position along the
        # (possibly rotated, possibly baseline-shifted) baseline — the same
        # way ``backend.lens.tree.decode_tree`` builds Lens-native spans.
        # Using ``base_left + base_w * t0`` (the previous behaviour) is only
        # correct for axis-aligned items; for rotated items it places the
        # span at the wrong image-space coordinates, which becomes visible
        # the moment the renderer emits per-span absolute positions.
        seg_start_px = t0 * base_w_px
        seg_end_px = t1 * base_w_px
        e1x = x1 + ux * seg_start_px
        e1y = y1 + uy * seg_start_px
        e2x = x1 + ux * seg_end_px
        e2y = y1 + uy * seg_end_px
        span_cx = (e1x + e2x) / 2.0
        span_cy = (e1y + e2y) / 2.0
        span_w_px = abs(t1 - t0) * base_w_px
        span_left_px = span_cx - span_w_px / 2.0
        span_top_px = span_cy - base_h_px / 2.0
        span_box = ensure_box_fields(
            {
                "left": span_left_px / W,
                "top": span_top_px / H,
                "width": span_w_px / W,
                "height": base_h_px / H,
                "rotation_deg": float(box.get("rotation_deg") or 0.0),
                "rotation_deg_css": float(box.get("rotation_deg_css") or 0.0),
                "center": {"x": span_cx / W, "y": span_cy / H},
            }
        )
        spans.append(
            {
                "side": "Ai",
                "para_index": para_index,
                "item_index": item_index,
                "span_index": span_i,
                "text": s,
                "valid_text": True,
                "start_raw": start_raw,
                "end_raw": end_raw,
                "t0_raw": t0,
                "t1_raw": t1,
                "box": span_box,
                "height_raw": item.get("height_raw"),
                "baseline_p1": item.get("baseline_p1"),
                "baseline_p2": item.get("baseline_p2"),
                "font_size_px": final_size,
            }
        )
        span_i += 1

    item["spans"] = spans
