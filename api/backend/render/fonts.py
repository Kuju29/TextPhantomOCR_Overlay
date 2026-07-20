"""Font resolution, loading and caching.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).

Three layers of caching keep this cheap:
- ``_resolve_cache``  : font path -> resolved path on disk (or "" if missing).
- ``_pair_cache``     : (thai, latin, size) -> (thai_font, latin_font) objects.
- BudouX parsers are constructed per language by :func:`budoux_parser`.

``ensure_font`` will, when allowed, download a missing font from a list of
mirror URLs.
"""

from __future__ import annotations

import json
import os

import httpx
from PIL import ImageFont

from backend.lens.languages import normalize as normalize_lang
from backend.render.text_utils import contains_thai

try:  # budoux is optional at import time
    import budoux
except Exception:  # pragma: no cover - defensive
    budoux = None  # type: ignore[assignment]

PILFont = ImageFont.FreeTypeFont | ImageFont.ImageFont

_resolve_cache: dict[str, str] = {}
_pair_cache: dict[tuple[str, str, int], tuple[PILFont, PILFont]] = {}

_SYSTEM_FONT_DIRS = (
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    os.path.expanduser("~/.fonts"),
)
_MIN_FONT_BYTES = 10_000


def ensure_font(path: str, urls: list[str]) -> str | None:
    """Resolve ``path`` to a usable font file, downloading it if necessary.

    Resolution order: explicit path on disk -> same filename under a system
    font dir -> download from ``urls``.  Returns ``None`` when nothing works.
    Every attempt that fails is reported via the project debug log so font
    issues stop being silent (a missing font made ``pick_font`` fall back to
    the bitmap default, which in turn broke the fit-size calculation).
    Results (including failures) are cached for the lifetime of the process.
    """
    from backend.log import dbg  # local import to dodge any circular references

    key = str(path or "")
    if key in _resolve_cache:
        return _resolve_cache[key] or None

    if path and os.path.isfile(path):
        _resolve_cache[key] = path
        return path

    # Search system font directories for a file with the same basename.
    basename = os.path.basename(path).lower()
    for root in _SYSTEM_FONT_DIRS:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                if fn.lower() == basename:
                    found = os.path.join(dirpath, fn)
                    _resolve_cache[key] = found
                    return found

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
            with open(path, "wb") as f:
                f.write(r.content)
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
        f"falling back to bitmap default. Last error: {last_error or 'no urls tried'}. "
        f"Place the font next to the CLI working directory to fix.",
        flush=True,
    )
    return None


def is_truetype(font: PILFont) -> bool:
    """True if ``font`` is a scalable TTF/OTF (not Pillow's bitmap default).

    The bitmap default returns a fixed-size box from ``textbbox`` regardless
    of the requested size, which silently breaks every fit-size calculation
    further down the pipeline — so callers that care about real metrics
    should check this before trusting the measurements.
    """
    return isinstance(font, ImageFont.FreeTypeFont)


def pick_font(text: str, thai_path: str, latin_path: str, size: int) -> PILFont:
    """Choose the Thai or Latin font for ``text`` and load it at ``size``.

    Prefers the Raqm layout engine (proper Thai shaping) and degrades
    gracefully to the basic engine, then to Pillow's bitmap default.
    """
    font_path = thai_path if contains_thai(text) else latin_path
    if font_path and os.path.isfile(font_path):
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
    return ImageFont.load_default()


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
