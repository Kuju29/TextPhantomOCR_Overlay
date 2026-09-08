from __future__ import annotations
from typing import Final

import re

PREFIX: Final[str] = "<<TP_P"
SUFFIX: Final[str] = ">>"
END_MARKER: Final[str] = "<<TP_END>>"
DONE_MARKER: Final[str] = "<<TP_DONE>>"
LINE_CONTRACT_VERSION: Final[str] = "plain_records_v1"

_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(\d+)>>")

def apply(paragraphs: list[str]) -> str:
    """Encode a list of paragraphs as ``<<TP_Pn>>\\n<text>`` blocks."""
    if not paragraphs:
        return ""
    parts: list[str] = []
    for i, text in enumerate(paragraphs):
        parts.append(f"{PREFIX}{i}{SUFFIX}\n{str(text or '')}")
    return "\n\n".join(parts)

def apply_wire(paragraphs: list[str]) -> str:
    """Encode literal source with the same compact grammar as output.

    This boundary never normalizes or escapes content. Source that cannot be
    represented as one physical record is rejected with a visible error.
    ``>>`` is allowed because the record parser uses the final close on its
    physical line; a nested TP marker is not allowed because it is ambiguous.
    """
    records: list[str] = []
    for i, value in enumerate(paragraphs):
        text = str(value or "")
        if any(ch in text for ch in ("\r", "\n", "\t", "\u0085", "\u2028", "\u2029")):
            raise ValueError(f"AI source P{i} cannot use compact wire: physical whitespace")
        if re.search(r"<<TP_P\d+", text):
            raise ValueError(f"AI source P{i} cannot use compact wire: nested marker")
        records.append(f"{PREFIX}{i}:{text}{SUFFIX}")
    return "\n".join(records)

def apply_schema_source(paragraphs: list[str]) -> str:
    """Encode schema-bound source without marker output syntax."""
    records: list[str] = []
    for i, value in enumerate(paragraphs):
        text = str(value or "")
        if any(ch in text for ch in ("\r", "\n", "\t", "\u0085", "\u2028", "\u2029")):
            raise ValueError(f"AI source P{i} cannot use schema source: physical whitespace")
        records.append(f"P{i}:{text}")
    return "\n".join(records)

def expected_count(marked_text: str) -> int:
    """Return N only for a contiguous, once-only P0..P(N-1) sequence."""
    return len(expected_ids(marked_text))

def expected_ids(marked_text: str) -> list[str]:
    """Return exact P0..Pn IDs only for a valid, once-only input sequence."""
    matches = [f"P{m.group(1)}" for m in _MARKER_RE.finditer(marked_text or "")]
    wanted = [f"P{i}" for i in range(len(matches))]
    return matches if matches == wanted else []

def translation_schema(marked_text: str, *, want_memo: bool = False) -> dict:
    """Strict flat object whose required keys are the source IDs."""
    ids = expected_ids(marked_text)
    if not ids:
        raise ValueError("translation schema requires contiguous P0..Pn markers")
    del want_memo  # Character memory remains provider input, not wire output.
    properties = {
        item: {"type": "string", "minLength": 1,
               "description": "Complete translation for this source unit."}
        for item in ids
    }
    return {"type": "object", "propertyOrdering": ids,
            "properties": properties, "required": ids,
            "additionalProperties": False}

def normalize_unit_text(text: str) -> str:
    """Remove provider formatting; line wrapping belongs to bubble geometry.

    Keep the answer's semantic spacing here. The renderer owns script-specific
    spacing rules, just as it did before the client-side rendering migration.
    """
    return re.sub(r"\s+", " ", str(text or "")).strip()
