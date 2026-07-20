"""Per-series AI conversation history (server-side) — "คุยต่อ ไม่เปิดแชทใหม่".

⛔ STATUS: DORMANT — ยังไม่ได้ใช้งาน เป็นแค่ไอเดียที่เขียนค้างไว้ (18 ก.ค. 2026).
NOT wired in: ไม่มีไฟล์ไหน import โมดูลนี้เลย (ตรวจ 20 ก.ค. 2026) — pipeline.py /
translate.py / routes ไม่เรียก record()/history() ใดๆ ทั้งสิ้น
ห้ามเข้าใจว่า flow "แชทต่อเนื่อง" ทำงานอยู่ — ปัจจุบันทุกหน้ายังเป็น request
อิสระ + series memory (glossary/characters) ที่ฉีดเข้า prompt เท่านั้น
ถ้าจะเปิดใช้: ต่อสาย 2 จุดใน jobs/pipeline.py (record() หลังได้ผล AI,
history() ก่อนเรียก translate) — ดูรายละเอียดด้านล่าง

The user's chosen design (18 Jul 2026): translating a page CONTINUES the same
chat the AI had for earlier pages of the same series — exactly like a chat
thread — instead of opening a fresh conversation for every page.  The prompt
(rules + worked examples) stays the MAIN engine; this history only carries the
model's own earlier choices (wordplay, casual register, pronouns, running
jokes) forward so the style does not flip-flop between pages.

Rules of the cache:

- Key = the extension's ``seriesKey`` (same scope as "Remember characters").
  MangaDex chapter URLs are resolved to the manga by the client already;
  name-in-URL sites (e.g. rawkuma ``/manga/<name>/chapter-10.5.../``) share
  one key across chapter URLs, so the chat continues across chapters.
- Order = (chapter, page).  The chapter number is parsed from the reader URL
  when present (``chapter-10.5`` -> 10.5); otherwise chapters are ordered by
  first appearance.  The page index comes from the client
  (``metadata.page_index``) or arrival order inside the chapter.
- Only finished AI translations are stored — never MT / another source — so
  the model always continues from how IT translated before.
- ``history()`` only ever returns pages strictly BEFORE the current one, in
  order.  Parallel jobs finishing out of order can only make the history
  SHORTER (a not-yet-finished neighbour is simply absent); the order can
  never be wrong.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any, Final

MAX_SERIES: Final[int] = 12
MAX_PAGES_PER_SERIES: Final[int] = 60
MAX_TEXT_CHARS: Final[int] = 6000
DEFAULT_WINDOW: Final[int] = 6

# "chapter-10.5.332436" -> 10.5 ; "chapter_7" / "chapter/12" also match.
_CHAPTER_NUM_RE: Final[re.Pattern[str]] = re.compile(
    r"chapter[-_/ .]?(\d+(?:\.\d+)?)", re.IGNORECASE
)
# MangaDex reader: /chapter/<uuid> — no number in the URL.
_MD_CHAPTER_RE: Final[re.Pattern[str]] = re.compile(r"/chapter/([a-f0-9-]{8,})", re.IGNORECASE)

_STORE_PATH: Final[Path] = Path.home() / ".textphantom" / "series_chat.json"

_lock = threading.Lock()
_data: dict[str, dict[str, Any]] | None = None


def _load_locked() -> dict[str, dict[str, Any]]:
    global _data
    if _data is None:
        try:
            raw = json.loads(_STORE_PATH.read_text(encoding="utf-8"))
            _data = raw if isinstance(raw, dict) else {}
        except Exception:
            _data = {}
    return _data


def _save_locked() -> None:
    try:
        _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _STORE_PATH.write_text(
            json.dumps(_data or {}, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass  # persistence is best-effort; in-memory copy keeps working


def _series_locked(series_key: str) -> dict[str, Any]:
    data = _load_locked()
    key = (series_key or "").strip() or "default"
    rec = data.get(key)
    if not isinstance(rec, dict):
        rec = {"chapters": {}, "pages": [], "at": time.time()}
        data[key] = rec
        # LRU across series.
        if len(data) > MAX_SERIES:
            for k in sorted(data, key=lambda k: data[k].get("at") or 0)[: len(data) - MAX_SERIES]:
                data.pop(k, None)
    rec["at"] = time.time()
    return rec


def _chapter_token_and_num(page_url: str) -> tuple[str, float | None]:
    url = (page_url or "").strip()
    m = _CHAPTER_NUM_RE.search(url)
    if m:
        try:
            return "ch:" + m.group(1), float(m.group(1))
        except ValueError:
            pass
    m = _MD_CHAPTER_RE.search(url)
    if m:
        return "md:" + m.group(1).lower(), None
    return "single", None


def _chapter_sort_locked(rec: dict[str, Any], token: str) -> float:
    """Stable sort value for a chapter: URL number when known, else the order
    the chapter was first seen (numbered and unnumbered never mix in practice
    because one site produces one URL shape)."""
    ch = rec["chapters"].get(token) or {}
    num = ch.get("num")
    if isinstance(num, (int, float)):
        return float(num)
    return 1_000_000.0 + float(ch.get("seq") or 0)


def begin_page(series_key: str, page_url: str, page_index: Any) -> dict[str, Any]:
    """Register the page being translated; return its identity for
    :func:`history` / :func:`record`.

    ``page_index`` is the client-supplied 1-based order inside the chapter;
    when missing (single right-click translate) the next arrival index in the
    chapter is assigned — sequential reading order, which is exactly how the
    user produces those jobs.
    """
    token, num = _chapter_token_and_num(page_url)
    with _lock:
        rec = _series_locked(series_key)
        ch = rec["chapters"].get(token)
        if not isinstance(ch, dict):
            ch = {"num": num, "seq": len(rec["chapters"])}
            rec["chapters"][token] = ch
        elif num is not None and ch.get("num") is None:
            ch["num"] = num
        try:
            idx = int(page_index)
            if idx <= 0:
                raise ValueError
        except (TypeError, ValueError):
            existing = [e["p"] for e in rec["pages"] if e.get("c") == token]
            idx = (max(existing) + 1) if existing else 1
        return {"chapter": token, "page": idx}


def history(
    series_key: str, identity: dict[str, Any], limit: int = DEFAULT_WINDOW
) -> list[tuple[str, str]]:
    """Return up to ``limit`` (source, ai_translation) pairs strictly BEFORE
    ``identity``, in reading order (oldest first)."""
    token = str(identity.get("chapter") or "")
    page = int(identity.get("page") or 0)
    with _lock:
        rec = _series_locked(series_key)
        cur = (_chapter_sort_locked(rec, token), page)
        entries = [
            e
            for e in rec["pages"]
            if (str(e.get("src") or "").strip() and str(e.get("ai") or "").strip())
            and (_chapter_sort_locked(rec, str(e.get("c") or "")), int(e.get("p") or 0)) < cur
        ]
        entries.sort(
            key=lambda e: (_chapter_sort_locked(rec, str(e.get("c") or "")), int(e.get("p") or 0))
        )
        return [(str(e["src"]), str(e["ai"])) for e in entries[-max(0, int(limit)):]]


def record(series_key: str, identity: dict[str, Any], src_text: str, ai_text: str) -> None:
    """Store one finished AI page (replaces an earlier translation of the
    same page, e.g. a user re-translate)."""
    src = (src_text or "").strip()[:MAX_TEXT_CHARS]
    ai = (ai_text or "").strip()[:MAX_TEXT_CHARS]
    if not src or not ai:
        return
    token = str(identity.get("chapter") or "")
    page = int(identity.get("page") or 0)
    with _lock:
        rec = _series_locked(series_key)
        rec["pages"] = [
            e for e in rec["pages"] if not (e.get("c") == token and int(e.get("p") or 0) == page)
        ]
        rec["pages"].append({"c": token, "p": page, "src": src, "ai": ai, "at": time.time()})
        if len(rec["pages"]) > MAX_PAGES_PER_SERIES:
            rec["pages"].sort(
                key=lambda e: (_chapter_sort_locked(rec, str(e.get("c") or "")), int(e.get("p") or 0))
            )
            rec["pages"] = rec["pages"][-MAX_PAGES_PER_SERIES:]
        _save_locked()


def clear(series_key: str = "") -> int:
    """Forget one series' chat (or ALL when ``series_key`` is empty).
    Returns the number of series records removed."""
    with _lock:
        data = _load_locked()
        if series_key.strip():
            removed = 1 if data.pop(series_key.strip(), None) is not None else 0
        else:
            removed = len(data)
            data.clear()
        _save_locked()
        return removed
