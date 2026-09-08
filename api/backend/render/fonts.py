"""Font resolution, loading and caching.

Three layers of caching keep this cheap:
- ``_resolve_cache``  : font path -> resolved path on disk (or "" if missing).
- ``_pair_cache``     : (thai, latin, size) -> (thai_font, latin_font) objects.
- BudouX parsers are constructed per language by :func:`budoux_parser`.

``ensure_font`` will, when allowed, download a missing font from a list of
mirror URLs.
"""

from __future__ import annotations
from PIL import ImageFont

import httpx, tempfile, json, sys, struct, os

from backend.lens.languages import normalize as normalize_lang
from backend.render.text_utils import contains_thai

try:  # budoux is optional at import time
    import budoux
except Exception:  # pragma: no cover - defensive
    budoux = None  # type: ignore[assignment]

PILFont = ImageFont.FreeTypeFont | ImageFont.ImageFont


class UnsupportedFontError(RuntimeError):
    """No installed/downloaded font can render all required text glyphs."""

    def __init__(self, text: str, script: str):
        self.text = text
        self.script = script
        points = ", ".join(f"U+{point:04X}" for point in _required_codepoints(text))
        super().__init__(f"no usable {script} font for {points or 'empty text'}")

_resolve_cache: dict[str, str] = {}
_pair_cache: dict[tuple[str, str, int], tuple[PILFont, PILFont]] = {}
_coverage_cache: dict[tuple[str, str], bool] = {}

def _system_font_dirs() -> tuple[str, ...]:
    """Return native scalable-font roots without assuming a Linux host."""
    roots = [
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        os.path.expanduser("~/.fonts"),
        "/System/Library/Fonts",
        "/Library/Fonts",
        os.path.expanduser("~/Library/Fonts"),
    ]
    windows_root = os.environ.get("WINDIR") or os.environ.get("SystemRoot")
    local_app_data = os.environ.get("LOCALAPPDATA")
    if windows_root:
        roots.append(os.path.join(windows_root, "Fonts"))
    if local_app_data:
        roots.append(os.path.join(local_app_data, "Microsoft", "Windows", "Fonts"))
    # Preserve order while avoiding duplicate scans (WINDIR and SystemRoot
    # normally identify the same directory).
    return tuple(dict.fromkeys(root for root in roots if root))


_SYSTEM_FONT_DIRS = _system_font_dirs()
_MIN_FONT_BYTES = 10_000

# Distribution-provided scalable faces used when the requested Noto file is
# unavailable (for example in an offline container).  These are paths to use,
# never files to copy over the requested cache target.
_SCRIPT_PROBES = {
    # The general Noto Sans route serves Latin, Greek and Cyrillic languages.
    "latin": (0x0041, 0x00E9, 0x03B1, 0x044F),
    "thai": (0x0E01, 0x0E32),        # ko kai, sara aa
    "cjk": (0x4E2D, 0x65E5),         # middle/China, sun/Japan
    "hangul": (0xAC00, 0xD55C),
    "arabic": (0x0627, 0x064A),      # alef, yeh
    "hebrew": (0x05D0, 0x05EA),      # alef, tav
    "devanagari": (0x0915, 0x093E), "bengali": (0x0995, 0x09BE),
    "tamil": (0x0B95, 0x0BBE), "telugu": (0x0C15, 0x0C3E),
    "malayalam": (0x0D15, 0x0D3E), "gujarati": (0x0A95, 0x0ABE),
    "gurmukhi": (0x0A15, 0x0A3E), "kannada": (0x0C95, 0x0CBE),
    "sinhala": (0x0D9A, 0x0DCF), "myanmar": (0x1000, 0x102C),
    "khmer": (0x1780, 0x17B6), "lao": (0x0E81, 0x0EB2),
    "armenian": (0x0531, 0x0561), "georgian": (0x10D0, 0x10D1),
    "ethiopic": (0x1200, 0x1201), "odia": (0x0B15, 0x0B3E),
}

_SCALABLE_FALLBACKS = {
    "latin": ("NotoSans-Regular.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf", "NimbusSans-Regular.otf", "arial.ttf", "segoeui.ttf"),
    "thai": ("NotoSansThai-Regular.ttf", "NotoSans-Regular.ttf", "Tahoma.ttf", "Garuda.ttf", "Loma.ttf"),
    "cjk": ("NotoSansCJKjp-Regular.otf", "NotoSansCJKsc-Regular.otf", "NotoSansCJKtc-Regular.otf", "NotoSansCJK-Regular.ttc", "DroidSansFallbackFull.ttf"),
    "hangul": ("NotoSansCJKkr-Regular.otf", "NotoSansKR-Regular.otf", "UnDotum.ttf", "NanumGothic.ttf"),
    "arabic": ("NotoSansArabic-Regular.ttf", "NotoNaskhArabic-Regular.ttf", "DejaVuSans.ttf"),
    "hebrew": ("NotoSansHebrew-Regular.ttf", "DejaVuSans.ttf"),
}
for _script_name in _SCRIPT_PROBES:
    if _script_name not in _SCALABLE_FALLBACKS:
        _family = "Oriya" if _script_name == "odia" else _script_name.title()
        _SCALABLE_FALLBACKS[_script_name] = (f"NotoSans{_family}-Regular.ttf",)

def _script_for_path(path: str) -> str:
    name = os.path.basename(path or "").lower()
    path_markers = {
        "devanagari": "devanagari", "bengali": "bengali", "tamil": "tamil",
        "telugu": "telugu", "malayalam": "malayalam", "gujarati": "gujarati",
        "gurmukhi": "gurmukhi", "kannada": "kannada", "sinhala": "sinhala",
        "myanmar": "myanmar", "khmer": "khmer", "lao": "lao", "armenian": "armenian",
        "georgian": "georgian", "ethiopic": "ethiopic", "oriya": "odia",
    }
    for marker, script in path_markers.items():
        if marker in name:
            return script
    if "thai" in name:
        return "thai"
    if "cjkkr" in name or "korean" in name or "hangul" in name:
        return "hangul"
    if "cjk" in name or name.startswith(("ipa", "wqy")):
        return "cjk"
    if "arabic" in name or "naskh" in name:
        return "arabic"
    if "hebrew" in name:
        return "hebrew"
    return "latin"

def _script_for_text(text: str, configured_path: str) -> str:
    for char in text or "":
        point = ord(char)
        if 0x0E00 <= point <= 0x0E7F:
            return "thai"
        ranges = (
            (0x0900, 0x097F, "devanagari"), (0x0980, 0x09FF, "bengali"),
            (0x0A00, 0x0A7F, "gurmukhi"), (0x0A80, 0x0AFF, "gujarati"),
            (0x0B00, 0x0B7F, "odia"), (0x0B80, 0x0BFF, "tamil"),
            (0x0C00, 0x0C7F, "telugu"), (0x0C80, 0x0CFF, "kannada"),
            (0x0D00, 0x0D7F, "malayalam"), (0x0D80, 0x0DFF, "sinhala"),
            (0x0E80, 0x0EFF, "lao"), (0x1000, 0x109F, "myanmar"),
            (0x0530, 0x058F, "armenian"), (0x10A0, 0x10FF, "georgian"),
            (0x1200, 0x137F, "ethiopic"), (0x1780, 0x17FF, "khmer"),
            (0x1100, 0x11FF, "hangul"), (0xAC00, 0xD7AF, "hangul"),
        )
        for start, end, script in ranges:
            if start <= point <= end:
                return script
        if 0x3040 <= point <= 0x30FF or 0x3400 <= point <= 0x9FFF:
            return "cjk"
        if 0x0590 <= point <= 0x05FF:
            return "hebrew"
        if 0x0600 <= point <= 0x06FF or 0x0750 <= point <= 0x077F:
            return "arabic"
    return _script_for_path(configured_path)

def _font_has_codepoint(data: bytes, point: int) -> bool:
    """Read enough of an SFNT cmap to test one Unicode codepoint."""
    face = 0
    if data[:4] == b"ttcf":
        if len(data) < 16:
            return False
        face = struct.unpack_from(">I", data, 12)[0]
    if len(data) < face + 12:
        return False
    tables = struct.unpack_from(">H", data, face + 4)[0]
    cmap_offset = None
    for index in range(tables):
        entry = face + 12 + index * 16
        if entry + 16 > len(data):
            return False
        tag, _checksum, offset, length = struct.unpack_from(">4sIII", data, entry)
        if tag == b"cmap" and offset + length <= len(data):
            cmap_offset = offset
            break
    if cmap_offset is None or cmap_offset + 4 > len(data):
        return False
    records = struct.unpack_from(">H", data, cmap_offset + 2)[0]
    for index in range(records):
        record = cmap_offset + 4 + index * 8
        if record + 8 > len(data):
            continue
        platform, encoding, relative = struct.unpack_from(">HHI", data, record)
        if platform not in (0, 3) or (platform == 3 and encoding not in (1, 10)):
            continue
        subtable = cmap_offset + relative
        if subtable + 2 > len(data):
            continue
        fmt = struct.unpack_from(">H", data, subtable)[0]
        if fmt == 4 and point <= 0xFFFF and subtable + 16 <= len(data):
            seg_count = struct.unpack_from(">H", data, subtable + 6)[0] // 2
            ends = subtable + 14
            starts = ends + seg_count * 2 + 2
            deltas = starts + seg_count * 2
            ranges = deltas + seg_count * 2
            for segment in range(seg_count):
                end = struct.unpack_from(">H", data, ends + segment * 2)[0]
                start = struct.unpack_from(">H", data, starts + segment * 2)[0]
                if start <= point <= end:
                    delta = struct.unpack_from(">h", data, deltas + segment * 2)[0]
                    range_word = ranges + segment * 2
                    range_offset = struct.unpack_from(">H", data, range_word)[0]
                    if range_offset == 0:
                        return (point + delta) % 65536 != 0
                    glyph_at = range_word + range_offset + (point - start) * 2
                    if glyph_at + 2 > len(data):
                        return False
                    glyph = struct.unpack_from(">H", data, glyph_at)[0]
                    return glyph != 0 and (glyph + delta) % 65536 != 0
        elif fmt in (12, 13) and subtable + 16 <= len(data):
            groups = struct.unpack_from(">I", data, subtable + 12)[0]
            for group in range(groups):
                item = subtable + 16 + group * 12
                if item + 12 > len(data):
                    break
                start, end, glyph = struct.unpack_from(">III", data, item)
                if start <= point <= end:
                    glyph_id = glyph + (point - start) if fmt == 12 else glyph
                    return glyph_id != 0
                if point < start:
                    break
    return False

def _font_supports_script(path: str, script: str) -> bool:
    key = (path, script)
    if key in _coverage_cache:
        return _coverage_cache[key]
    try:
        with open(path, "rb") as font_file:
            data = font_file.read()
        supported = all(_font_has_codepoint(data, point) for point in _SCRIPT_PROBES[script])
    except (OSError, KeyError, struct.error):
        supported = False
    _coverage_cache[key] = supported
    return supported

def _required_codepoints(text: str) -> tuple[int, ...]:
    def required(char: str) -> bool:
        point = ord(char)
        # Variation selectors modify the preceding glyph and are commonly
        # absent from otherwise-capable text fonts. They are not glyphs on
        # their own and must not veto that font.
        variation_selector = 0xFE00 <= point <= 0xFE0F or 0xE0100 <= point <= 0xE01EF
        return char.isprintable() and not char.isspace() and not variation_selector

    return tuple(sorted({ord(char) for char in text if required(char)}))

def _font_supports_text(path: str, text: str) -> bool:
    points = _required_codepoints(text)
    if not points:
        return True
    key = (path, "text:" + ",".join(map(str, points)))
    if key in _coverage_cache:
        return _coverage_cache[key]
    try:
        with open(path, "rb") as font_file:
            data = font_file.read()
        supported = all(_font_has_codepoint(data, point) for point in points)
    except (OSError, struct.error):
        supported = False
    _coverage_cache[key] = supported
    return supported

def _find_system_font(
    names: tuple[str, ...], script: str, *, scan_all: bool = True, required_text: str = ""
) -> str | None:
    wanted = {name.lower() for name in names}
    named: dict[str, list[str]] = {name.lower(): [] for name in names}
    remaining: list[str] = []
    for root in _SYSTEM_FONT_DIRS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in filenames:
                candidate = os.path.join(dirpath, filename)
                if filename.lower() in wanted:
                    named[filename.lower()].append(candidate)
                if filename.lower().endswith((".ttf", ".otf", ".ttc")):
                    remaining.append(candidate)
    for name in names:
        for candidate in named[name.lower()]:
            if (_font_supports_text(candidate, required_text) if required_text else _font_supports_script(candidate, script)):
                return candidate
    if not scan_all:
        return None
    # A distro may package a capable face under an unfamiliar name. Coverage,
    # not naming, is authoritative for this second pass.
    for candidate in remaining:
        if (_font_supports_text(candidate, required_text) if required_text else _font_supports_script(candidate, script)):
            return candidate
    return None

def ensure_font(path: str, urls: list[str]) -> str | None:
    """Resolve ``path`` to a usable font file, downloading it if necessary.

    Resolution order: explicit path on disk -> same filename/system scalable
    fallback -> download from ``urls``.  Returns ``None`` when nothing works.
    Every attempt that fails is reported via the project debug log so font
    issues stop being silent (a missing font made ``pick_font`` fall back to
    the bitmap default, which in turn broke the fit-size calculation).
    Results (including failures) are cached for the lifetime of the process.
    """
    from backend.log import dbg  # local import to dodge any circular references

    key = str(path or "")
    script = _script_for_path(path)
    if key in _resolve_cache:
        return _resolve_cache[key] or None

    if path and os.path.isfile(path) and _font_supports_script(path, script):
        _resolve_cache[key] = path
        return path

    # Search system font directories for a file with the same basename.
    exact_system_font = _find_system_font((os.path.basename(path),), script, scan_all=False)
    if exact_system_font:
        _resolve_cache[key] = exact_system_font
        return exact_system_font

    # Prefer an already-installed face before making a runtime network call.
    # This is especially important on Windows: earlier releases searched only
    # Unix font roots, then attempted remote Noto downloads and finally emitted
    # a false degradation even though Windows had suitable scalable fonts.
    scalable_fallback = _find_system_font(_SCALABLE_FALLBACKS[script], script)
    if scalable_fallback:
        _resolve_cache[key] = scalable_fallback
        dbg("fonts.resolve.scalable_fallback", {"requested": path, "path": scalable_fallback})
        return scalable_fallback

    # Download from a mirror. Each failure is logged so it isn't silent.
    last_error = ""
    for url in urls:
        try:
            r = httpx.get(url, timeout=30)
            if r.status_code != 200:
                last_error = f"HTTP {r.status_code} from {url}"
                dbg("fonts.download.bad_status", last_error)
                continue
            if len(r.content) <= _MIN_FONT_BYTES:
                last_error = f"too small ({len(r.content)} bytes) from {url}"
                dbg("fonts.download.too_small", last_error)
                continue
            # Validate before publishing and replace atomically, so a bad or
            # interrupted response cannot destroy a usable cache entry.
            parent = os.path.dirname(os.path.abspath(path))
            os.makedirs(parent, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=".font-", suffix=".tmp", dir=parent)
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(r.content)
                # Pillow fully parses the face here; keeping no reference is
                # sufficient because FreeTypeFont has no public close method.
                ImageFont.truetype(temporary, size=12)
                if not _font_supports_script(temporary, script):
                    raise ValueError(f"font lacks required {script} glyph coverage")
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            if os.path.isfile(path):
                _resolve_cache[key] = path
                dbg("fonts.download.ok", {"path": path, "url": url, "bytes": len(r.content)})
                return path
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc} ({url})"
            dbg("fonts.download.exception", last_error)
            continue

    _resolve_cache[key] = ""
    # The dbg helper is no-op without TP_DEBUG, but font failures matter even
    # in normal runs — emit one stderr line so the CLI / docker logs surface it.
    print(
        f"[TextPhantom][fonts] WARNING: could not obtain {path!r}; "
        f"no scalable fallback with required {script} glyphs is installed; "
        f"render metrics will use the unsupported-font layout fallback. "
        f"Last error: {last_error or 'no urls tried'}. Place the font next to "
        f"the CLI working directory to fix.",
        file=sys.stderr,
        flush=True,
    )
    return None

def is_truetype(font: PILFont) -> bool:
    """True only for a scalable TTF/OTF loaded from a validated disk file.

    Pillow's default may be bitmap or, since Pillow 12, an in-memory
    ``FreeTypeFont``. Neither is accepted because tofu/default metrics silently
    break fit-size calculations.
    """
    if not isinstance(font, ImageFont.FreeTypeFont):
        return False
    # Pillow 12 implements load_default() with an in-memory FreeTypeFont.
    # Runtime fonts here always originate from validated files, so requiring
    # a real path prevents that default/tofu face from masquerading as usable.
    path = getattr(font, "path", None)
    try:
        return isinstance(path, (str, bytes, os.PathLike)) and os.path.isfile(os.fspath(path))
    except (OSError, TypeError):
        return False

def pick_font(text: str, thai_path: str, latin_path: str, size: int) -> PILFont:
    """Choose the Thai or Latin font for ``text`` and load it at ``size``.

    Prefers the Raqm layout engine (proper shaping) and degrades to Pillow's
    basic engine. Missing glyph coverage is explicit; Pillow's default/tofu
    font is never returned as if it were a usable scalable face.
    """
    font_path = thai_path if contains_thai(text) else latin_path
    script = _script_for_text(text, font_path)
    if font_path and os.path.isfile(font_path) and _font_supports_text(font_path, text):
        try:
            return ImageFont.truetype(
                font_path,
                size=size,
                layout_engine=getattr(ImageFont, "LAYOUT_RAQM", 0),
            )
        except Exception:
            try:
                return ImageFont.truetype(font_path, size=size)
            except Exception:
                pass
    # Callers can pass unresolved configured paths (downloads may be disabled),
    # so make one final local scalable-font attempt before accepting bitmap.
    fallback = _find_system_font(_SCALABLE_FALLBACKS[script], script, required_text=text)
    if fallback:
        try:
            return ImageFont.truetype(fallback, size=size)
        except Exception:
            pass
    raise UnsupportedFontError(text, script)

def font_pair(thai_path: str, latin_path: str, size: int) -> tuple[PILFont, PILFont]:
    """Return cached ``(thai_font, latin_font)`` objects at ``size``."""
    key = (str(thai_path or ""), str(latin_path or ""), int(size))
    cached = _pair_cache.get(key)
    if cached:
        return cached
    pair = (
        pick_font("ก", thai_path, latin_path, size),
        pick_font("A", thai_path, latin_path, size),
    )
    _pair_cache[key] = pair
    return pair

def budoux_parser(lang: str):
    """Return a BudouX line-break parser for ``lang`` (or ``None``).

    BudouX gives natural word boundaries for languages without spaces
    (Thai / Japanese / Chinese).  ``BUDOUX_MODEL_PATH`` can supply a custom
    model for any other language.
    """
    if budoux is None:
        return None
    code = normalize_lang(lang)
    if code == "th":
        return budoux.load_default_thai_parser()
    if code == "ja":
        return budoux.load_default_japanese_parser()
    if code in ("zh", "zh-cn"):
        return budoux.load_default_simplified_chinese_parser()
    if code == "zh-tw":
        return budoux.load_default_traditional_chinese_parser()

    model_path = os.environ.get("BUDOUX_MODEL_PATH")
    if not model_path:
        return None
    with open(model_path, "r", encoding="utf-8") as f:
        return budoux.Parser(json.load(f))
