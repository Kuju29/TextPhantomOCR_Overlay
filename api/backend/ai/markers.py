"""Paragraph-marker protocol used to keep AI translations aligned with the

original paragraph order.

The OCR step gives us N original paragraphs.  We feed them to the LLM as

    <<TP_P0>>
    paragraph zero
    <<TP_P1>>
    paragraph one
    ...

and expect the same markers back, in the same order.  If the model drops or
mangles markers the renderer would otherwise mis-align translated text with
its rendering boxes — so this module owns the parsing/repair logic.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Final, NoReturn

from backend.ai.errors import ModelOutputContractError

PREFIX: Final[str] = "<<TP_P"
SUFFIX: Final[str] = ">>"

_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(\d+)>>")
_BROKEN_MARKER_RE: Final[re.Pattern[str]] = re.compile(r"<<TP_P(?!\d+>>)[^\s>]*>?")


@dataclass(frozen=True)
class DecodedTranslation:
    """One model answer decoded without changing any translated value."""

    ai_text_full: str
    memo: str
    response_shape: str
    accepted_losslessly: bool = True
    content_modified: bool = False
    missing_ids: tuple[str, ...] = ()


def apply(paragraphs: list[str]) -> str:
    """Encode a list of paragraphs as ``<<TP_Pn>>\\n<text>`` blocks."""
    if not paragraphs:
        return ""
    parts: list[str] = []
    for i, text in enumerate(paragraphs):
        parts.append(f"{PREFIX}{i}{SUFFIX}\n{(text or '').strip()}")
    return "\n\n".join(parts)


def expected_count(marked_text: str) -> int:
    """Return N only for a contiguous input marker sequence P0..P(N-1)."""
    indices = sorted(extract_indices(marked_text))
    if not indices or indices != list(range(len(indices))):
        return 0
    return len(indices)


def expected_ids(marked_text: str) -> list[str]:
    """Return exact P0..Pn IDs only for a valid, once-only input sequence."""
    matches = [f"P{m.group(1)}" for m in _MARKER_RE.finditer(marked_text or "")]
    wanted = [f"P{i}" for i in range(len(matches))]
    return matches if matches == wanted else []


def translation_schema(marked_text: str, *, want_memo: bool = False) -> dict:
    """Provider-neutral schema for the canonical one-shot envelope."""
    ids = expected_ids(marked_text)
    if not ids:
        raise ValueError("translation schema requires contiguous P0..Pn markers")
    return {
        "type": "object",
        "propertyOrdering": ["translations", "memo"],
        "properties": {
            "translations": {
                "type": "array",
                "description": (
                    f"Exactly {len(ids)} entries, one per source unit, in the input order "
                    f"{', '.join(ids)}. Never omit, duplicate, reorder or renumber an entry."
                ),
                "minItems": len(ids),
                "maxItems": len(ids),
                "items": {
                    "type": "object",
                    "propertyOrdering": ["id", "text"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "enum": ids,
                            "description": "The <<TP_Pn>> marker id this entry answers.",
                        },
                        "text": {
                            "type": "string",
                            "description": (
                                "The complete translation of that one unit. If and only if the "
                                "unit cannot be translated, return an empty string here — never "
                                "drop the entry and never substitute the source text."
                            ),
                        },
                    },
                    "required": ["id", "text"],
                    "additionalProperties": False,
                },
            },
            "memo": {
                "type": "string",
                "description": (
                    "Character-memory lines, or an empty string when none."
                    if want_memo
                    else "Always an empty string; character memory is disabled."
                ),
            },
        },
        "required": ["translations", "memo"],
        "additionalProperties": False,
    }


class _DuplicateJsonKey(ValueError):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise _DuplicateJsonKey(key)
        obj[key] = value
    return obj


_FENCE_RE: Final[re.Pattern[str]] = re.compile(
    r"\A```(?:json)?[ \t]*\n?([\s\S]*?)\n?```\Z", re.IGNORECASE
)
_XML_WRAPPER_RE: Final[re.Pattern[str]] = re.compile(
    r"\A<AiTextFull>([\s\S]*)</AiTextFull>\Z", re.IGNORECASE
)


def _unwrap_known_response(raw: str) -> tuple[str, bool]:
    """Strip only whole-response wrappers; never search/repair content."""
    text = str(raw or "").strip()
    fenced = _FENCE_RE.fullmatch(text)
    if fenced:
        return fenced.group(1).strip(), True
    tagged = _XML_WRAPPER_RE.fullmatch(text)
    if tagged:
        return tagged.group(1).strip(), True
    return text, False


def _canonical_markers(values: list[str]) -> str:
    """Attach protocol markers while preserving every value byte-for-byte."""
    return "\n\n".join(f"{PREFIX}{i}{SUFFIX}\n{value}" for i, value in enumerate(values))


# Aligns received values to the full expected sequence, leaving an empty string
# where the model omitted an id. An omission is reported, never invented.
def _align_to_expected(
    received: list[str], values: list[str], expected: list[str]
) -> tuple[list[str], list[str]]:
    by_id = dict(zip(received, values))
    aligned = [by_id.get(item, "") for item in expected]
    missing = [item for item in expected if item not in by_id]
    return aligned, missing


def _contract_error(message: str, shape: str, **details: object) -> NoReturn:
    raise ModelOutputContractError(message, response_shape=shape, **details)


# Rejects an ambiguous id set. A missing id is not ambiguous: it is one unit the
# model did not answer, and it is reported rather than treated as a broken page.
def _validate_id_set(
    received: list[str], expected: list[str], shape: str, *, ordered: bool
) -> None:
    duplicates = sorted({item for item in received if received.count(item) > 1})
    extra = [item for item in received if item not in expected]
    if duplicates or extra:
        _contract_error(
            "AI translation IDs do not match the input",
            shape,
            expectedIds=expected,
            receivedIds=received,
            missingIds=[item for item in expected if item not in received],
            extraIds=extra,
            duplicateIds=duplicates,
        )
    if ordered and received != [item for item in expected if item in received]:
        _contract_error(
            "AI translation IDs are out of order",
            shape,
            expectedIds=expected,
            receivedIds=received,
            outOfOrderIds=received,
        )


def _decode_marker_text(
    text: str, expected: list[str], shape: str
) -> tuple[list[str], str, list[str]]:
    """Decode a complete marker answer; any structural uncertainty is fatal."""
    if text.count(MEMO_MARKER) > 1:
        _contract_error("AI answer contains duplicate memo markers", shape, duplicateFields=["memo"])
    body, separator, memo = text.partition(MEMO_MARKER)
    if separator and _MARKER_RE.search(memo):
        _contract_error("AI answer has translation markers after memo", shape, ambiguous=["markerAfterMemo"])
    matches = list(_MARKER_RE.finditer(body))
    if body.count(PREFIX) != len(matches):
        _contract_error("AI answer contains malformed paragraph markers", shape, ambiguous=["malformedMarker"])
    if not matches:
        _contract_error("AI answer contains no paragraph markers", shape, missingIds=expected)
    if body[: matches[0].start()].strip():
        _contract_error("AI answer contains text outside paragraph markers", shape, ambiguous=["leadingText"])
    received = [f"P{match.group(1)}" for match in matches]
    _validate_id_set(received, expected, shape, ordered=True)
    values: list[str] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        values.append(body[match.end() : end].strip())
    aligned, missing = _align_to_expected(received, values, expected)
    return aligned, memo.strip(), missing


def decode_translation_response(raw: str, expected: list[str]) -> DecodedTranslation:
    """Decode one generation using only lossless, unambiguous response shapes.

    Accepted shapes are the canonical envelope, legacy flat P0..Pn JSON, a
    legacy ``aiTextFull`` JSON string containing all markers, and complete
    plain markers.  No value is guessed, filled, merged, renumbered or sent
    back to a model for repair.
    """
    if not expected or expected != [f"P{i}" for i in range(len(expected))]:
        raise ValueError("expected IDs must be the exact sequence P0..Pn")
    text, wrapped = _unwrap_known_response(raw)
    if not text:
        _contract_error("AI returned empty text", "empty", missingIds=expected)

    if text.startswith("{") or text.endswith("}"):
        shape = "json_wrapped" if wrapped else "json"
        if not (text.startswith("{") and text.endswith("}")):
            _contract_error("AI returned an incomplete JSON object", shape, ambiguous=["partialJson"])
        try:
            obj = json.loads(text, object_pairs_hook=_unique_object)
        except _DuplicateJsonKey as exc:
            _contract_error("AI JSON contains a duplicate key", shape, duplicateFields=[exc.key])
        except (TypeError, ValueError, json.JSONDecodeError):
            _contract_error("AI returned invalid JSON", shape, ambiguous=["invalidJson"])
        if not isinstance(obj, dict):
            _contract_error("AI JSON is not an object", shape, fieldTypeErrors=["$:object"])

        keys = list(obj)
        if "translations" in obj:
            shape = "canonical_envelope_wrapped" if wrapped else "canonical_envelope"
            missing_fields = [key for key in ("translations", "memo") if key not in obj]
            extra_fields = [key for key in keys if key not in ("translations", "memo")]
            if missing_fields or extra_fields:
                _contract_error(
                    "AI envelope fields do not match the contract",
                    shape,
                    missingFields=missing_fields,
                    extraFields=extra_fields,
                    topLevelKeys=keys,
                )
            translations = obj.get("translations")
            memo = obj.get("memo")
            if not isinstance(translations, list) or not isinstance(memo, str):
                failures = []
                if not isinstance(translations, list):
                    failures.append("translations:array")
                if not isinstance(memo, str):
                    failures.append("memo:string")
                _contract_error("AI envelope contains a wrong field type", shape, fieldTypeErrors=failures)
            ids: list[str] = []
            values: list[str] = []
            entry_errors: list[str] = []
            for index, entry in enumerate(translations):
                if not isinstance(entry, dict):
                    entry_errors.append(f"translations[{index}]:object")
                    continue
                extra = [key for key in entry if key not in ("id", "text")]
                missing = [key for key in ("id", "text") if key not in entry]
                if extra or missing:
                    entry_errors.append(f"translations[{index}]:fields")
                    continue
                if not isinstance(entry["id"], str):
                    entry_errors.append(f"translations[{index}].id:string")
                    continue
                if not isinstance(entry["text"], str):
                    entry_errors.append(f"translations[{index}].text:string")
                    continue
                ids.append(entry["id"])
                values.append(entry["text"])
            if entry_errors:
                _contract_error("AI envelope contains an invalid entry", shape, fieldTypeErrors=entry_errors)
            _validate_id_set(ids, expected, shape, ordered=True)
            aligned, missing_ids = _align_to_expected(ids, values, expected)
            return DecodedTranslation(
                _canonical_markers(aligned), memo, shape, missing_ids=tuple(missing_ids)
            )

        p_keys = [key for key in keys if re.fullmatch(r"P\d+", key)]
        if p_keys:
            shape = "flat_json_wrapped" if wrapped else "flat_json"
            allowed = set(expected) | {"memo"}
            missing = [item for item in expected if item not in obj]
            extra = [key for key in keys if key not in allowed]
            wrong_types = [key for key in expected if key in obj and not isinstance(obj[key], str)]
            if "memo" in obj and not isinstance(obj["memo"], str):
                wrong_types.append("memo")
            if extra or wrong_types:
                _contract_error(
                    "AI flat JSON does not match the input",
                    shape,
                    missingIds=missing,
                    extraIds=[key for key in extra if re.fullmatch(r"P\d+", key)],
                    extraFields=[key for key in extra if not re.fullmatch(r"P\d+", key)],
                    nonStringFields=wrong_types,
                    topLevelKeys=keys,
                )
            if len(missing) == len(expected):
                _contract_error(
                    "AI flat JSON answered none of the input units",
                    shape,
                    missingIds=missing,
                    topLevelKeys=keys,
                )
            values = [str(obj.get(item) or "") for item in expected]
            return DecodedTranslation(
                _canonical_markers(values), str(obj.get("memo") or ""), shape,
                missing_ids=tuple(missing),
            )

        if "aiTextFull" in obj:
            shape = "ai_text_full_json_wrapped" if wrapped else "ai_text_full_json"
            extra = [key for key in keys if key not in ("aiTextFull", "memo")]
            wrong_types = [
                key
                for key in ("aiTextFull", "memo")
                if key in obj and not isinstance(obj[key], str)
            ]
            if extra or wrong_types:
                _contract_error(
                    "AI aiTextFull JSON does not match the legacy contract",
                    shape,
                    extraFields=extra,
                    nonStringFields=wrong_types,
                )
            values, inline_memo, missing_ids = _decode_marker_text(obj["aiTextFull"], expected, shape)
            if inline_memo and "memo" in obj:
                _contract_error("AI answer supplies memo in two locations", shape, ambiguous=["twoMemoLocations"])
            memo = inline_memo if inline_memo else str(obj.get("memo") or "")
            return DecodedTranslation(
                _canonical_markers(values), memo, shape, missing_ids=tuple(missing_ids)
            )

        _contract_error(
            "AI JSON has no supported translation shape",
            "unknown_json_wrapped" if wrapped else "unknown_json",
            topLevelKeys=keys,
            ambiguous=["unsupportedShape"],
        )

    shape = "plain_markers_wrapped" if wrapped else "plain_markers"
    values, memo, missing_ids = _decode_marker_text(text, expected, shape)
    return DecodedTranslation(
        _canonical_markers(values), memo, shape, missing_ids=tuple(missing_ids)
    )


def parse_translation_object(raw: str, expected: int) -> tuple[str, str] | None:
    """Parse a P0..Pn JSON object into canonical markers and memo.

    Returns ``None`` when a universal prompt-only model ignored JSON entirely;
    callers may then accept a complete legacy marker answer from that same
    response. Missing, extra or non-string P fields are refused rather than
    guessed or repaired. Empty strings remain structurally valid so the caller
    can apply punctuation passthrough or report a semantic missing unit.
    """
    text = str(raw or "").strip()
    if not text or "{" not in text:
        return None
    # Tolerate markdown fences/prose around prompt-only JSON without trying to
    # repair malformed values. Native structured providers never need this.
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    wanted = {f"P{i}" for i in range(expected)}
    allowed = wanted | {"memo"}
    if not wanted.issubset(obj) or not set(obj).issubset(allowed):
        return None
    values: list[str] = []
    for i in range(expected):
        value = obj.get(f"P{i}")
        if not isinstance(value, str):
            return None
        values.append(normalize_unit_text(value))
    return apply(values), str(obj.get("memo") or "").strip()


def extract_indices(text: str) -> set[int]:
    """Return the set of marker indices present in ``text``."""
    if not text:
        return set()
    out: set[int] = set()
    for m in _MARKER_RE.finditer(text):
        try:
            out.add(int(m.group(1)))
        except (TypeError, ValueError):
            continue
    return out


MEMO_MARKER: Final[str] = "<<TP_MEMO>>"


def split_memo(text: str) -> tuple[str, str]:
    """Split off the optional trailing ``<<TP_MEMO>>`` character-notes block.

    The prompt asks the model to append character observations (name, gender,
    speech style) after the last paragraph, behind a ``<<TP_MEMO>>`` marker.
    Returns ``(text_without_memo, memo_text)``; ``memo_text`` is ``""`` when
    the block is absent.  Everything from the FIRST memo marker onward is
    treated as memo so a stray duplicate can never leak into the render.
    """
    t = text or ""
    if MEMO_MARKER not in t:
        return t, ""
    body, _, memo = t.partition(MEMO_MARKER)
    memo = memo.replace(MEMO_MARKER, "\n").strip()
    return body.rstrip(), memo


def has_complete_sequence(ai_text_full: str, expected: int) -> bool:
    """True iff markers 0..expected-1 appear in order in ``ai_text_full``."""
    if expected <= 0:
        return True
    text = ai_text_full or ""
    needed = list(range(expected))
    if sorted(extract_indices(text))[: len(needed)] != needed:
        return False
    last = -1
    for i in needed:
        pos = text.find(f"<<TP_P{i}>>")
        if pos < 0 or pos <= last:
            return False
        last = pos
    return True


def normalize_unit_text(text: str) -> str:
    """Remove provider formatting; line wrapping belongs to bubble geometry.

    Keep the answer's semantic spacing here. The renderer owns script-specific
    spacing rules, just as it did before the client-side rendering migration.
    """
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _collapse_ws(text: str) -> str:
    """Backward-compatible internal name used by marker repair."""
    return normalize_unit_text(text)


def sanitize(marked_text: str) -> str:
    """Normalise a raw LLM response into the canonical ``<<TP_Pi>>\\n<text>``
    form expected by :func:`extract_paragraphs`.

    Steps:
    1. Normalise newlines.
    2. Repair broken markers like ``<<TP_P`` or ``<<TP_Pabc`` (drop them).
    3. Ensure each marker sits on its own line.
    4. Re-emit markers in the order they appear.
    """
    text = str(marked_text or "")
    if not text:
        return ""

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _BROKEN_MARKER_RE.sub("", text)
    # Force a newline between a marker and inline content.
    text = re.sub(r"(?m)^\s*(<<TP_P\d+>>)\s*(\S)", r"\1\n\2", text)

    cleaned_lines: list[str] = []
    for line in text.split("\n"):
        if "<<TP_P" not in line:
            cleaned_lines.append(line)
            continue
        only = re.match(r"^\s*(<<TP_P\d+>>)\s*$", line)
        if only:
            cleaned_lines.append(only.group(1))
            continue
        split = re.match(r"^\s*(<<TP_P\d+>>)\s*(.*)$", line)
        if split:
            cleaned_lines.append(split.group(1))
            rest = (split.group(2) or "").strip()
            if rest:
                cleaned_lines.append(rest)
            continue
        cleaned_lines.append(re.sub(r"<<TP_P\d+>>", "", line))

    text = "\n".join(cleaned_lines)

    indices = sorted(extract_indices(text))
    if not indices:
        return _collapse_ws(text)

    out_lines: list[str] = []
    for idx in indices:
        marker = f"<<TP_P{idx}>>"
        m = re.search(rf"{re.escape(marker)}\s*([\s\S]*?)(?=<<TP_P\d+>>|\Z)", text)
        segment = _collapse_ws(m.group(1) if m else "")
        out_lines.append(marker)
        out_lines.append(segment)
        out_lines.append("")
    return "\n".join(out_lines).strip("\n")


def extract_paragraphs(text: str, expected: int) -> tuple[list[str], str] | None:
    """Pull out the paragraph texts in marker order.

    Returns ``(paragraphs, clean_text)`` where ``paragraphs`` has length
    ``expected`` (missing slots are empty strings) and ``clean_text`` is the
    same data joined by ``\\n\\n`` (suitable for storing as ``aiTextFull``).
    Returns ``None`` if no markers are found at all.
    """
    if not text or expected <= 0 or "<<TP_P" not in text:
        return None
    matches = list(_MARKER_RE.finditer(text))
    if not matches:
        return None

    out: list[str] = [""] * expected
    for i, m in enumerate(matches):
        try:
            idx = int(m.group(1))
        except (TypeError, ValueError):
            continue
        seg_start = m.end()
        seg_end = matches[i + 1].start() if (i + 1) < len(matches) else len(text)
        # Some providers mix real marker newlines with literal escaped line
        # breaks inside a segment.  They are provider formatting, not bubble
        # geometry; normalize them before the shared whitespace collapse.
        raw_seg = re.sub(r"\\r\\n|\\n|\\r", " ", text[seg_start:seg_end])
        seg = normalize_unit_text(raw_seg)
        if 0 <= idx < expected and not out[idx]:
            out[idx] = seg

    return out, "\n\n".join(out)


_LETTER_RE: Final[re.Pattern[str]] = re.compile(r"\w", re.UNICODE)


# Whether a unit holds prose a translator can act on, i.e. at least one letter.
# Mirrors `hasTranslatableText` in src/shared/lens-document.js.
def has_translatable_text(text: str) -> bool:
    return any(ch.isalpha() for ch in str(text or ""))


def has_meaningful_text(text: str) -> bool:
    """True iff the text contains anything beyond just markers / whitespace."""
    stripped = _MARKER_RE.sub("", str(text or ""))
    return bool(stripped.strip())


def clamp_runaway_repeats(s: str, max_repeat: int = 12) -> str:
    """Collapse runs of the same character longer than ``max_repeat``.

    Some LLMs hallucinate ``"...........................…"`` when they see
    ellipses in dialogue.  Clipping these before a retry stops the model
    from getting "stuck" on the same pattern.
    """
    if not s:
        return ""
    pat = re.compile(r"(.)\1{" + str(max_repeat) + r",}")
    return pat.sub(lambda m: m.group(1) * max_repeat, s)


def clamp_output_repeats(
    s: str, max_char_repeat: int = 12, max_cluster_repeat: int = 4
) -> str:
    """Deterministic guard against LLM repetition runaways in the OUTPUT.

    Manga SFX in the source (ヒヤァァァ…, ハハハハ…) randomly push models into
    emitting thousands of repeated characters or repeated short clusters
    until the token budget is exhausted.  This cannot be predicted, so every
    AI response passes through this clamp before parsing/rendering:

    * runs of ONE character longer than ``max_char_repeat`` collapse to
      ``max_char_repeat`` (the stylistic "ฮิยาาาาาาาาาาาา" survives);
    * a short CLUSTER (2-16 chars) repeated more than ``max_cluster_repeat``
      times collapses to ``max_cluster_repeat`` reps ("ฮ่าฮ่าฮ่า…" stays
      readable).  A 16-char phrase repeated 5+ times back-to-back is never
      legitimate dialogue.  Iterates until stable so nested runaways fully
      collapse.

    Markers like ``<<TP_P3>>`` are unaffected: consecutive markers differ in
    their digits, so they never form an identical repeated cluster.
    """
    if not s:
        return ""
    s = clamp_runaway_repeats(s, max_char_repeat)
    pat = re.compile(r"(.{2,16}?)\1{" + str(max_cluster_repeat) + r",}", re.DOTALL)
    prev = None
    while prev != s:
        prev = s
        s = pat.sub(lambda m: m.group(1) * max_cluster_repeat, s)
    return s
