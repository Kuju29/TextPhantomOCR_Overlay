"""Parse the optional character-memo block of an AI response."""

from __future__ import annotations


def parse_character_memo(memo: str) -> list[dict]:
    """Parse the ``<<TP_MEMO>>`` block into character entries.

    Expected line format (loosely enforced — LLM output varies):

        Name | gender: female | speech: cheerful, formal wording | note: guild receptionist

    Returns a list of ``{"name", "gender", "speech", "note"}`` dicts with
    empty/unknown fields omitted.  Best-effort: malformed lines are skipped.
    """
    out: list[dict] = []
    for line in (memo or "").splitlines():
        line = line.strip().lstrip("-•*").strip()
        if not line or line.lower() in ("none", "n/a", "-"):
            continue
        parts = [p.strip() for p in line.split("|")]
        name = parts[0].strip()
        if not name or len(name) > 40:
            continue
        entry: dict = {"name": name}
        for part in parts[1:]:
            key, _, val = part.partition(":")
            key = key.strip().lower()
            val = val.strip()
            if key == "notes":
                key = "note"
            if key in ("gender", "speech", "note") and val and val.lower() != "unknown":
                entry[key] = val[:120]
        out.append(entry)
        if len(out) >= 12:
            break
    return out

