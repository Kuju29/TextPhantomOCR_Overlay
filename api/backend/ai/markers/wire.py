from __future__ import annotations
from typing import Final

import re

PREFIX: Final[str] = "<<TP_P"
SUFFIX: Final[str] = ">>"
END_MARKER: Final[str] = "<<TP_END>>"
DONE_MARKER: Final[str] = "<<TP_DONE>>"
LINE_CONTRACT_VERSION: Final[str] = "plain_records_v1"

_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(\d+)>>")
_CONVERSATION_ID_RE: Final[re.Pattern[str]] = re.compile(r"I[1-9][0-9]{0,6}_P[0-9]{1,6}")
_LEGACY_ID_RE: Final[re.Pattern[str]] = re.compile(r"P[0-9]{1,6}")

def valid_output_id(value: str) -> bool:
    value = str(value or "")
    return bool(_LEGACY_ID_RE.fullmatch(value) or _CONVERSATION_ID_RE.fullmatch(value))

def record_open(id_value: str) -> str:
    """Return the compact record opener for one provider-visible ID."""
    value = str(id_value or "")
    if not valid_output_id(value):
        raise ValueError(f"invalid translation output ID: {value!r}")
    return f"<<{value}" if value.startswith("I") else f"<<TP_{value}"

def apply_wire_ids(paragraphs: list[str], ids: list[str] | tuple[str, ...]) -> str:
    """Encode source records with explicit stable IDs.

    Independent keeps ``<<TP_Pn:...>>`` while Conversation can use
    ``<<I<image>_P<unit>:...>>`` without a repeated page-boundary prose block.
    """
    values = list(ids or ())
    if len(values) != len(paragraphs) or not values or any(not valid_output_id(v) for v in values) or len(set(values)) != len(values):
        raise ValueError("translation source IDs are invalid or incomplete")
    records: list[str] = []
    for id_value, raw in zip(values, paragraphs):
        text = str(raw or "")
        if any(ch in text for ch in ("\r", "\n", "\t", "\u0085", "\u2028", "\u2029")):
            raise ValueError(f"AI source {id_value} cannot use compact wire: physical whitespace")
        if re.search(r"<<(?:TP_P\d+|I[1-9][0-9]{0,6}_P[0-9]{1,6})", text):
            raise ValueError(f"AI source {id_value} cannot use compact wire: nested marker")
        records.append(f"{record_open(id_value)}:{text}{SUFFIX}")
    return "\n".join(records)

def apply_schema_source_ids(paragraphs: list[str], ids: list[str] | tuple[str, ...]) -> str:
    values = list(ids or ())
    if len(values) != len(paragraphs) or not values or any(not valid_output_id(v) for v in values) or len(set(values)) != len(values):
        raise ValueError("translation schema source IDs are invalid or incomplete")
    records: list[str] = []
    for id_value, raw in zip(values, paragraphs):
        text = str(raw or "")
        if any(ch in text for ch in ("\r", "\n", "\t", "\u0085", "\u2028", "\u2029")):
            raise ValueError(f"AI source {id_value} cannot use schema source: physical whitespace")
        records.append(f"{id_value}:{text}")
    return "\n".join(records)

def translation_schema_ids(ids: list[str] | tuple[str, ...]) -> dict:
    values = list(ids or ())
    if not values or any(not valid_output_id(v) for v in values) or len(set(values)) != len(values):
        raise ValueError("translation schema requires unique valid IDs")
    properties = {item: {"type": "string", "minLength": 1,
                         "description": "Complete translation for this source unit."}
                  for item in values}
    return {"type": "object", "propertyOrdering": values,
            "properties": properties, "required": values,
            "additionalProperties": False}

def apply(paragraphs: list[str]) -> str:
    """Encode a list of paragraphs as ``<<TP_Pn>>\\n<text>`` blocks."""
    if not paragraphs:
        return ""
    parts: list[str] = []
    for i, text in enumerate(paragraphs):
        parts.append(f"{PREFIX}{i}{SUFFIX}\n{str(text or '')}")
    return "\n\n".join(parts)

def apply_wire(paragraphs: list[str]) -> str:
    """Encode literal source with the legacy compact Pn grammar."""
    return apply_wire_ids(paragraphs, [f"P{i}" for i in range(len(paragraphs))])

def apply_schema_source(paragraphs: list[str]) -> str:
    """Encode schema-bound source with legacy Pn IDs."""
    return apply_schema_source_ids(paragraphs, [f"P{i}" for i in range(len(paragraphs))])

def expected_count(marked_text: str) -> int:
    """Return N only for a contiguous, once-only P0..P(N-1) sequence."""
    return len(expected_ids(marked_text))

def expected_ids(marked_text: str) -> list[str]:
    """Return exact P0..Pn IDs only for a valid, once-only input sequence."""
    matches = [f"P{m.group(1)}" for m in _MARKER_RE.finditer(marked_text or "")]
    wanted = [f"P{i}" for i in range(len(matches))]
    return matches if matches == wanted else []

def translation_schema(marked_text: str, *, want_memo: bool = False) -> dict:
    """Strict flat object whose required keys are the legacy source IDs."""
    ids = expected_ids(marked_text)
    if not ids:
        raise ValueError("translation schema requires contiguous P0..Pn markers")
    del want_memo
    return translation_schema_ids(ids)

def normalize_unit_text(text: str) -> str:
    """Remove provider formatting; line wrapping belongs to bubble geometry.

    Keep the answer's semantic spacing here. The renderer owns script-specific
    spacing rules, just as it did before the client-side rendering migration.
    """
    return re.sub(r"\s+", " ", str(text or "")).strip()
