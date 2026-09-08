from __future__ import annotations

def build_glossary_block(glossary: list[dict] | None, limit: int = 40) -> str:
    """Render a short glossary / translation-memory block for the prompt.

    ``glossary`` is a list of ``{"src": ..., "tgt": ...}`` pairs collected from
    the user's recent translations (across multiple images in one session).
    Injecting them keeps NAMES and recurring TERMS consistent from page to
    page — the same role a human scanlator's term sheet plays.

    Accuracy guards:
    - very short sources (< 3 chars) are skipped: they are almost always
      interjections/particles ("Ha", "eh", "!?") whose best translation
      depends on the scene — pinning them makes later pages stiff;
    - only the most recent ``limit`` unique source terms are kept so the
      prompt stays small.

    Returns ``""`` when there is nothing usable.
    """
    if not glossary:
        return ""
    seen: set[str] = set()
    lines: list[str] = []
    for entry in reversed(glossary):  # most-recent first
        if not isinstance(entry, dict):
            continue
        src = str(entry.get("src") or "").strip()
        tgt = str(entry.get("tgt") or "").strip()
        if not src or not tgt or src in seen:
            continue
        if len(src) < 3:  # interjection/particle — context beats memory
            continue
        seen.add(src)
        lines.append(f"  - {src} → {tgt}")
        if len(lines) >= limit:
            break
    if not lines:
        return ""
    lines.reverse()  # restore chronological order for readability
    return (
        "TRANSLATION MEMORY (names, places, skills, items from earlier pages — use the SAME target wording "
        "for the SAME source term). This binds recurring names/terms only; everyday words and interjections "
        "are always free to follow the scene:\n"
        + "\n".join(lines)
    )

def looks_like_term(src: str, tgt: str, min_len: int = 3) -> bool:
    """Heuristic: is ``src => tgt`` a reusable TERM (name/place/skill/item)?

    Guards the glossary and the brief's TERMS block against full sentences and
    interjections, which poison later pages when pinned.  ``min_len`` is 2 for
    brief-authored terms (CJK names are often exactly 2 chars) and 3 for
    memo-harvested pairs.
    """
    s, t = (src or "").strip(), (tgt or "").strip()
    if not s or not t or len(s) < min_len:
        return False
    if len(s) > 40 or len(t) > 60:
        return False
    if "\n" in s or "\n" in t:
        return False
    # Sentence punctuation (interior) = a sentence, not a term.
    if any(ch in s for ch in "。.!?！？…,、"):
        return False
    if len(s.split()) > 5:
        return False
    return True

# ⛔ NOTE: build_series_block / build_speaker_block / build_prev_context_block
# ยัง ACTIVE ในโค้ด (ถูกเรียกจาก build_system_split) แต่ปัจจุบันได้ค่า "ว่าง" เสมอ
# เพราะข้อมูลต้นทาง (bible/speakers/prev_context) มาจาก chapter-brief flow ที่
# dormant อยู่ — บล็อกพวกนี้จึงไม่ปรากฏใน prompt จริงตอนนี้
def build_series_block(series_state: str) -> str:
    """Render the frozen series bible (STORY SO FAR) block, or ``""``."""
    state = (series_state or "").strip()
    if not state:
        return ""
    return (
        "STORY SO FAR (series bible from reading the whole chapter — background evidence for tone, "
        "relationships and scene; current source evidence takes precedence. NEVER restate or translate it in the output):\n" + state
    )

def build_speaker_block(speakers: dict | None) -> str:
    """Render this page's marker->speaker map (from the chapter brief).

    ``speakers`` maps paragraph indices to character names, e.g.
    ``{"0": "Rey", "2": "Marnie"}``.  Unknown markers are simply absent.
    Returns ``""`` when there is nothing usable.
    """
    if not isinstance(speakers, dict) or not speakers:
        return ""
    lines: list[str] = []
    for idx in sorted(speakers, key=lambda k: int(k) if str(k).isdigit() else 0):
        name = str(speakers[idx] or "").strip()
        if name:
            lines.append(f"  <<TP_P{idx}>> = {name}")
        if len(lines) >= 50:
            break
    if not lines:
        return ""
    return (
        "SPEAKER MAP (decided from the WHOLE chapter — trust it over per-line guessing; give each "
        "line the voice its speaker has in the character sheet):\n" + "\n".join(lines)
    )

def build_prev_context_block(prev_context: list | None, limit: int = 6) -> str:
    """Render the previous page's SOURCE tail for cross-page flow (R4).

    ``prev_context`` is ``[{"src": ..., "who": ...?}, ...]`` in reading order —
    source text only (from OCR), so parallel translation never waits on another
    page's result.  Returns ``""`` when there is nothing usable.
    """
    if not isinstance(prev_context, list) or not prev_context:
        return ""
    lines: list[str] = []
    for entry in prev_context[-limit:]:
        if not isinstance(entry, dict):
            continue
        src = str(entry.get("src") or "").strip().replace("\n", " ")
        if not src:
            continue
        who = str(entry.get("who") or "").strip()
        lines.append(f"  [{who}] {src}"[:200] if who else f"  {src}"[:200])
    if not lines:
        return ""
    return (
        "PREVIOUS PAGE (source text tail, context only — the conversation may continue from here; "
        "do NOT translate or output these lines):\n" + "\n".join(lines)
    )

def build_character_block(
    characters: list[dict] | None, limit: int = 30, has_image: bool = False
) -> str:
    """Render the accumulated per-series character sheet for the prompt.

    ``characters`` is a list of ``{"name", "gender", "speech", "note"}`` dicts
    the client accumulated from earlier pages (via the ``<<TP_MEMO>>`` block).
    The sheet is the AUTHORITY for gender: gendered speech is only allowed for
    characters listed here with a known gender (style rule 3), which is what
    lets long-running series get ครับ/ค่ะ right without guessing.
    Returns ``""`` when there is nothing usable.
    """
    if not characters:
        return ""
    lines: list[str] = []
    for c in characters[-limit:]:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        bits = [name]
        for key in ("gender", "speech", "note"):
            val = str(c.get(key) or "").strip()
            if val:
                bits.append(f"{key}: {val}")
        lines.append("  - " + " | ".join(bits))
    if not lines:
        return ""
    return (
        "CHARACTER SHEET (accumulated from earlier pages of this series — use as evidence; current explicit source text takes precedence):\n"
        + "\n".join(lines)
        + "\nGendered wording requires explicit source evidence or an identified character with known gender. "
        "Appearance alone is insufficient. Unknown entries do not override new explicit evidence. Known "
        "gender permits suitable wording; it does not require extra pronouns or polite particles. Preserve "
        "necessary register and conversational functions according to the target-language style. Use "
        "speech and note fields as context, not sentence templates; do not assign an unknown speaker "
        "another character's voice."
    )


